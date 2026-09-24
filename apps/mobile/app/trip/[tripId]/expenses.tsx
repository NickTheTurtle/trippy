import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { formatDay, formatMoney } from '@trippy/copy/format';
import { api, ApiError } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import { Button, Card, EmptyState, FormError, Loading, Screen } from '../../../src/ui';
import { Picker, SegmentedControl } from '../../../src/ui/controls';
import { ExpenseSheet, PaymentSheet } from '../../../src/screens/ExpenseSheet';
import type { Expense, ExpensesData, Transfer } from '../../../src/screens/ExpenseSheet';
import { color, space, type } from '../../../src/theme';

const SECTIONS = ['expenses', 'balances', 'settle'] as const;
type Section = (typeof SECTIONS)[number];

function formatSpentOn(iso: string): string {
	if (!iso) return '';
	return formatDay(iso, { year: iso.slice(0, 4) !== String(new Date().getFullYear()) });
}

function netFor(expense: Expense, userId: string): number {
	return (expense.payer_id === userId ? expense.home_cents : 0) - (expense.shares[userId] ?? 0);
}

export default function Expenses() {
	const tripId = useTripId();
	const toast = useToast();
	const { data, error, loading, reload } = useApi<ExpensesData>(`/trips/${tripId}/expenses`);
	useLiveSection(['expenses', 'members', 'trip'], reload);
	const [section, setSection] = useState<Section>('expenses');
	const [editing, setEditing] = useState<Expense | null>(null);
	const [adding, setAdding] = useState(false);
	const [payment, setPayment] = useState<Expense | null>(null);
	const [viewAs, setViewAs] = useState('');
	const settleBusy = useRef(new Set<string>());
	const [settleNonce, setSettleNonce] = useState(0);

	const settle = useMutation(
		async (transfer: Transfer) => {
			if (settleBusy.current.has(transfer.token)) return;
			settleBusy.current.add(transfer.token);
			setSettleNonce((n) => n + 1);
			try {
				await api(`/trips/${tripId}/expenses/settle`, {
					method: 'POST',
					body: {
						fromId: transfer.fromId,
						toId: transfer.toId,
						amountCents: transfer.amountCents,
						token: transfer.token
					}
				});
			} finally {
				settleBusy.current.delete(transfer.token);
				setSettleNonce((n) => n + 1);
			}
		},
		{ fallback: copy.expenses.settleRow.fallback, onSuccess: reload }
	);

	useEffect(() => {
		if (settle.error) toast.error(settle.error);
	}, [settle.error, toast]);

	// A refused save keeps the version the sheet opened on, as on web, so a
	// second Save is refused again rather than written over the other person's
	// change. Taking the fresh row's version while the draft stayed on screen
	// turned the conflict check into a lost update one tap later. The list
	// behind the sheet reloads so their version is there to read.
	function refreshEditingAfterConflict() {
		reload();
	}

	if (loading && !data) return <Loading />;
	if (!data) {
		return (
			<Screen>
				<FormError message={error ?? copy.api.loadFailed} />
				<Button label={copy.api.retry} onPress={reload} />
			</Screen>
		);
	}

	const spend = data.expenses.filter((expense) => expense.settlement !== 1);
	const spent = spend.reduce((sum, expense) => sum + expense.home_cents, 0);
	const perPerson = data.members.length ? Math.round(spent / data.members.length) : spent;
	const mine = viewAs ? spend.reduce((sum, expense) => sum + (expense.shares[viewAs] ?? 0), 0) : 0;
	const shown = viewAs
		? data.expenses.filter(
				(expense) => expense.shares[viewAs] !== undefined || expense.payer_id === viewAs
			)
		: data.expenses;
	const unsettled = data.balances.filter((b) => b.netCents !== 0);
	const fmt = (cents: number) => formatMoney(cents, data.currency);

	const byDay = new Map<string, Expense[]>();
	for (const expense of shown) {
		const day = expense.spent_on || '';
		byDay.set(day, [...(byDay.get(day) ?? []), expense]);
	}

	return (
		<>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				{error ? <FormError message={error} /> : null}
				{section === 'expenses' && data.expenses.length > 0 ? (
					<Card>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
							<View style={{ flex: 1 }}>
								<Text style={type.faint}>{copy.expenses.tripTotal}</Text>
								<Text style={type.head}>{fmt(spent)}</Text>
							</View>
							<View style={{ flex: 1 }}>
								<Text style={type.faint}>
									{viewAs ? shareLabel(data.members, viewAs, data.me) : copy.expenses.perPerson}
								</Text>
								<Text style={type.head}>{fmt(viewAs ? mine : perPerson)}</Text>
							</View>
							<AddButton onPress={() => setAdding(true)} />
						</View>
					</Card>
				) : section === 'expenses' ? (
					<Card>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
							<View style={{ flex: 1 }} />
							<AddButton onPress={() => setAdding(true)} />
						</View>
					</Card>
				) : null}

				<SegmentedControl
					items={SECTIONS.map((s) => ({ key: s, label: copy.expenses.sections[s] }))}
					active={section}
					onPick={(k) => setSection(k as Section)}
				/>

				{section === 'expenses' ? (
					<>
						{data.expenses.length > 0 ? (
							<ViewAs members={data.members} me={data.me} value={viewAs} onChange={setViewAs} />
						) : null}
						<Card>
							{shown.length === 0 ? (
								<EmptyState
									message={
										data.expenses.length === 0
											? copy.common.nothingAdded
											: copy.expenses.noneForMember(
													viewAs === data.me
														? copy.expenses.youTag
														: (data.members.find((m) => m.id === viewAs)?.name ?? '')
												)
									}
								/>
							) : (
								<View style={{ gap: space.lg }}>
									{[...byDay.entries()].map(([day, rows]) => (
										<View key={day} style={{ gap: space.sm }}>
											<Text style={{ ...type.faint, fontWeight: '600' }}>{formatSpentOn(day)}</Text>
											{rows.map((expense) => (
												<ExpenseLine
													key={expense.id}
													expense={expense}
													home={data.currency}
													net={viewAs ? netFor(expense, viewAs) : undefined}
													onOpen={() =>
														expense.settlement === 1 ? setPayment(expense) : setEditing(expense)
													}
												/>
											))}
										</View>
									))}
								</View>
							)}
						</Card>
					</>
				) : null}

				{section === 'balances' ? (
					<Card>
						{unsettled.length === 0 ? (
							<EmptyState message={copy.expenses.allEven} />
						) : (
							<View>
								{unsettled
									.sort((a, b) => b.netCents - a.netCents)
									.map((b) => (
										<View key={b.id} style={{ flexDirection: 'row', paddingVertical: space.sm }}>
											<Text style={{ ...type.body, flex: 1 }}>
												{b.name}
												{b.id === data.me ? ` (${copy.expenses.youTag})` : ''}
												{b.former ? ` · ${copy.expenses.formerTag}` : ''}
											</Text>
											<Text
												style={{
													...type.small,
													color: b.netCents > 0 ? color.accentInk : color.dangerInk
												}}
											>
												{b.netCents > 0 ? '+' : ''}
												{fmt(b.netCents)}
											</Text>
										</View>
									))}
							</View>
						)}
					</Card>
				) : null}

				{section === 'settle' ? (
					<Card>
						{data.settlement.length === 0 ? (
							<EmptyState message={copy.expenses.nothingToSettle} />
						) : (
							<View>
								{data.settlement.map((transfer) => {
									const busy = settleBusy.current.has(transfer.token);
									void settleNonce;
									return (
										<View
											key={`${transfer.fromId}-${transfer.toId}`}
											style={{
												flexDirection: 'row',
												alignItems: 'center',
												gap: space.md,
												paddingVertical: space.sm
											}}
										>
											<Text style={{ ...type.body, flex: 1 }}>
												<Text style={{ fontWeight: '600' }}>{transfer.from}</Text>{' '}
												{copy.expenses.settleRow.pays} {transfer.to}
											</Text>
											<Text style={type.small}>{fmt(transfer.amountCents)}</Text>
											<Pressable
												disabled={busy}
												accessibilityRole="button"
												accessibilityLabel={copy.expenses.settleRow.markPaidLabel(
													transfer.from,
													transfer.to,
													fmt(transfer.amountCents)
												)}
												onPress={() => void settle.run(transfer)}
											>
												<Text
													style={{
														...type.small,
														color: busy ? color.inkFaint : color.accent,
														fontWeight: '600'
													}}
												>
													{busy
														? copy.expenses.settleRow.busyLabel
														: copy.expenses.settleRow.markPaid}
												</Text>
											</Pressable>
										</View>
									);
								})}
							</View>
						)}
					</Card>
				) : null}
			</Screen>

			{adding || editing ? (
				<ExpenseSheet
					open
					tripId={tripId}
					data={data}
					expense={editing}
					onClose={() => {
						setAdding(false);
						setEditing(null);
					}}
					onSaved={() => {
						setAdding(false);
						setEditing(null);
						reload();
					}}
					onConflict={refreshEditingAfterConflict}
				/>
			) : null}
			{payment ? (
				<PaymentSheet
					open
					tripId={tripId}
					payment={payment}
					home={data.currency}
					onClose={() => setPayment(null)}
					onSaved={() => {
						setPayment(null);
						reload();
					}}
				/>
			) : null}
		</>
	);
}

function ExpenseLine({
	expense,
	home,
	net,
	onOpen
}: {
	expense: Expense;
	home: string;
	net?: number;
	onOpen: () => void;
}) {
	const credit = expense.amount_cents < 0;
	const settled = expense.settlement === 1;
	return (
		<Pressable
			onPress={onOpen}
			style={{ flexDirection: 'row', gap: space.md, paddingVertical: space.sm }}
			accessibilityLabel={
				settled
					? copy.expenses.row.openLabel(expense.description)
					: copy.common.editLabel(expense.description)
			}
		>
			<View style={{ flex: 1 }}>
				<Text style={{ ...type.body, fontWeight: '600' }}>{expense.description}</Text>
				<Text style={type.faint}>
					{settled
						? formatSpentOn(expense.spent_on)
						: `${expense.payer_name} ${credit ? copy.expenses.row.received : copy.expenses.row.paid} · ${copy.expenses.row.splitLabel(expense.split_mode, expense.participants)}`}
					{expense.needsReview ? ` · ${copy.expenses.row.reviewTitle}` : ''}
				</Text>
			</View>
			<View style={{ alignItems: 'flex-end' }}>
				{net === undefined ? (
					<>
						<Text style={{ ...type.small, color: credit ? color.accentInk : color.inkSoft }}>
							{formatMoney(expense.amount_cents, expense.currency)}
						</Text>
						{expense.converted ? (
							<Text style={type.faint}>≈ {formatMoney(expense.home_cents, home)}</Text>
						) : null}
					</>
				) : (
					<>
						<Text
							style={{
								...type.small,
								color: net > 0 ? color.accentInk : net < 0 ? color.dangerInk : color.inkSoft
							}}
						>
							{net > 0 ? '+' : ''}
							{formatMoney(net, home)}
						</Text>
						{!settled ? (
							<Text style={type.faint}>
								{copy.expenses.row.ofTotal(formatMoney(expense.home_cents, home))}
							</Text>
						) : null}
					</>
				)}
			</View>
		</Pressable>
	);
}

function ViewAs({
	members,
	me,
	value,
	onChange
}: {
	members: { id: string; name: string }[];
	me: string;
	value: string;
	onChange: (value: string) => void;
}) {
	if (members.length < 2) return null;
	return (
		<Card style={{ gap: space.sm }}>
			<Text style={type.faint}>{copy.viewAs.label}</Text>
			<Picker
				options={[
					{ key: '', label: copy.viewAs.everyone },
					...members.map((m) => ({
						key: m.id,
						label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
					}))
				]}
				value={value}
				onPick={onChange}
			/>
		</Card>
	);
}

function shareLabel(members: { id: string; name: string }[], id: string, me: string): string {
	return id === me
		? copy.viewAs.yourShare
		: copy.viewAs.share(members.find((m) => m.id === id)?.name ?? '');
}

function AddButton({ onPress }: { onPress: () => void }) {
	return (
		<Pressable onPress={onPress} hitSlop={8}>
			<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
				{copy.expenses.addExpense}
			</Text>
		</Pressable>
	);
}
