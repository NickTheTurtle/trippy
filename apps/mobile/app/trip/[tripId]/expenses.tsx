import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { formatDay, formatMoney } from '@trippy/copy/format';
import { api, ApiError } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import {
	Button,
	EmptyState,
	FormError,
	GroupedRow,
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { ExpenseSheet, PaymentSheet } from '../../../src/screens/ExpenseSheet';
import type { Expense, ExpensesData, Transfer } from '../../../src/screens/ExpenseSheet';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import { AppSymbol } from '../../../src/ui/Symbol';
import { Sheet } from '../../../src/ui/Sheet';
import { Avatar, Tag } from '../../../src/ui/marks';
import { color, rowInset, space, type } from '../../../src/theme';
import { lazyTab } from '../../../src/ui/nativeTabs';

const SECTIONS = ['expenses', 'balances', 'settle'] as const;
type Section = (typeof SECTIONS)[number];

function formatSpentOn(iso: string): string {
	if (!iso) return '';
	return formatDay(iso, { year: iso.slice(0, 4) !== String(new Date().getFullYear()) });
}

function netFor(expense: Expense, userId: string): number {
	return (expense.payer_id === userId ? expense.home_cents : 0) - (expense.shares[userId] ?? 0);
}

export default lazyTab(Expenses);

function Expenses() {
	const tripId = useTripId();
	const toast = useToast();
	const { data, error, loading, reload } = useApi<ExpensesData>(`/trips/${tripId}/expenses`);
	useLiveSection(['expenses', 'members', 'trip'], reload);
	const [section, setSection] = useState<Section>('expenses');
	const [editing, setEditing] = useState<Expense | null>(null);
	const [adding, setAdding] = useState(false);
	const [payment, setPayment] = useState<Expense | null>(null);
	const [viewAs, setViewAs] = useState('');
	const [viewAsOpen, setViewAsOpen] = useState(false);
	const settleBusy = useRef(new Set<string>());
	const [settleNonce, setSettleNonce] = useState(0);
	const addExpenseAction = useCallback(() => setAdding(true), []);
	useTripHeaderAction(data && section === 'expenses' ? addExpenseAction : null);

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
				<SegmentedControl
					items={SECTIONS.map((s) => ({ key: s, label: copy.expenses.sections[s] }))}
					active={section}
					onPick={(k) => setSection(k as Section)}
				/>

				{section === 'expenses' ? (
					<>
						{data.expenses.length > 0 ? (
							<InsetSection>
								<View style={styles.stats}>
									<View style={{ flex: 1, gap: 2 }}>
										<Text style={type.footnote}>{copy.expenses.tripTotal}</Text>
										<Text style={type.title3}>{fmt(spent)}</Text>
									</View>
									<View style={{ flex: 1, gap: 2 }}>
										<Text style={type.footnote}>
											{viewAs ? shareLabel(data.members, viewAs, data.me) : copy.expenses.perPerson}
										</Text>
										<Text style={type.title3}>{fmt(viewAs ? mine : perPerson)}</Text>
									</View>
								</View>
							</InsetSection>
						) : null}
						{data.expenses.length > 0 && data.members.length >= 2 ? (
							<InsetSection>
								<ListRow
									title={copy.viewAs.label}
									value={
										viewAs
											? (data.members.find((member) => member.id === viewAs)?.name ??
												shareLabel(data.members, viewAs, data.me))
											: copy.viewAs.everyone
									}
									onPress={() => setViewAsOpen(true)}
									last
								/>
							</InsetSection>
						) : null}
						{shown.length === 0 ? (
							<EmptyState
								graphic={data.expenses.length === 0}
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
							[...byDay.entries()].map(([day, rows]) => (
								<InsetSection key={day} title={formatSpentOn(day)}>
									{rows.map((expense, index) => (
										<ExpenseLine
											key={expense.id}
											expense={expense}
											home={data.currency}
											net={viewAs ? netFor(expense, viewAs) : undefined}
											onOpen={() =>
												expense.settlement === 1 ? setPayment(expense) : setEditing(expense)
											}
											last={index === rows.length - 1}
										/>
									))}
								</InsetSection>
							))
						)}
					</>
				) : null}

				{section === 'balances' ? (
					unsettled.length === 0 ? (
						<EmptyState message={copy.expenses.allEven} />
					) : (
						<InsetSection>
							{unsettled
								.sort((a, b) => b.netCents - a.netCents)
								.map((b, index) => (
									<BalanceRow
										key={b.id}
										balance={b}
										me={data.me}
										fmt={fmt}
										last={index === unsettled.length - 1}
									/>
								))}
						</InsetSection>
					)
				) : null}

				{section === 'settle' ? (
					data.settlement.length === 0 ? (
						<EmptyState message={copy.expenses.nothingToSettle} />
					) : (
						<InsetSection>
							{data.settlement.map((transfer, index) => {
								const busy = settleBusy.current.has(transfer.token);
								void settleNonce;
								return (
									<TransferRow
										key={`${transfer.fromId}-${transfer.toId}`}
										transfer={transfer}
										fmt={fmt}
										busy={busy}
										onSettle={() => void settle.run(transfer)}
										last={index === data.settlement.length - 1}
									/>
								);
							})}
						</InsetSection>
					)
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
			<ViewAsSheet
				open={viewAsOpen}
				members={data.members}
				me={data.me}
				value={viewAs}
				onClose={() => setViewAsOpen(false)}
				onPick={(value) => {
					setViewAs(value);
					setViewAsOpen(false);
				}}
			/>
		</>
	);
}

function ExpenseLine({
	expense,
	home,
	net,
	onOpen,
	last
}: {
	expense: Expense;
	home: string;
	net?: number;
	onOpen: () => void;
	last: boolean;
}) {
	const credit = expense.amount_cents < 0;
	const settled = expense.settlement === 1;
	const c = copy.expenses.row;
	const tag = settled ? c.paymentTag : credit ? c.incomeTag : null;
	return (
		<GroupedRow
			onPress={onOpen}
			last={last}
			accessory="chevron"
			accessibilityLabel={[
				settled ? c.openLabel(expense.description) : copy.common.editLabel(expense.description),
				// The tag and the warning mark are folded into the row on iOS, so what
				// they mean has to be in the row's own label to be heard at all.
				tag,
				expense.needsReview ? c.reviewTitle : null
			]
				.filter(Boolean)
				.join('. ')}
			leading={<Avatar name={expense.payer_name} tone={credit ? 'muted' : 'accent'} />}
			trailing={
				<View style={styles.amount}>
					{net === undefined ? (
						<>
							<Text style={[styles.amountText, { color: credit ? color.accentInk : color.ink }]}>
								{formatMoney(expense.amount_cents, expense.currency)}
							</Text>
							{expense.converted ? (
								<Text style={styles.micro}>≈ {formatMoney(expense.home_cents, home)}</Text>
							) : null}
						</>
					) : (
						<>
							<Text
								style={[
									styles.amountText,
									{ color: net > 0 ? color.accentInk : net < 0 ? color.dangerInk : color.ink }
								]}
							>
								{net > 0 ? '+' : ''}
								{formatMoney(net, home)}
							</Text>
							{!settled ? (
								<Text style={styles.micro}>{c.ofTotal(formatMoney(expense.home_cents, home))}</Text>
							) : null}
						</>
					)}
				</View>
			}
		>
			{/* As on web, the marks are siblings of the description rather than inline
			    in its text, so a long description wraps (to two lines) instead of
			    pushing the thing that flags the row out of view. Each mark sits in a
			    box one text line tall, so it centres on the first line, not the pair. */}
			<View style={styles.titleLine}>
				<Text style={styles.title} numberOfLines={2}>
					{expense.description}
				</Text>
				{tag ? (
					<View style={styles.mark}>
						<Tag label={tag} tone="accent" outline />
					</View>
				) : null}
				{expense.needsReview ? (
					<View style={styles.mark} accessible accessibilityLabel={c.reviewTitle}>
						<AppSymbol
							name="exclamationmark.triangle.fill"
							fallback="warning-outline"
							size={15}
							color={color.warn}
						/>
					</View>
				) : null}
			</View>
			{/* Web ends this line with the date; here the day's section header above
			    already says it, so it is left off. That leaves a settlement, whose
			    description already names both sides, with no second line at all. */}
			{settled ? null : (
				<Text style={type.faint}>
					{`${expense.payer_name} ${credit ? c.received : c.paid} · ${c.splitLabel(expense.split_mode, expense.participants)}`}
				</Text>
			)}
		</GroupedRow>
	);
}

function ViewAsSheet({
	open,
	members,
	me,
	value,
	onClose,
	onPick
}: {
	open: boolean;
	members: { id: string; name: string }[];
	me: string;
	value: string;
	onClose: () => void;
	onPick: (value: string) => void;
}) {
	return (
		<Sheet open={open} title={copy.viewAs.label} onClose={onClose}>
			<InsetSection>
				{[
					{ key: '', label: copy.viewAs.everyone },
					...members.map((m) => ({
						key: m.id,
						label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
					}))
				].map((option, index, options) => (
					<ListRow
						key={option.key}
						title={option.label}
						accessory={option.key === value ? 'checkmark' : 'none'}
						accessibilityState={{ selected: option.key === value }}
						onPress={() => onPick(option.key)}
						last={index === options.length - 1}
					/>
				))}
			</InsetSection>
		</Sheet>
	);
}

function shareLabel(members: { id: string; name: string }[], id: string, me: string): string {
	return id === me
		? copy.viewAs.yourShare
		: copy.viewAs.share(members.find((m) => m.id === id)?.name ?? '');
}

function BalanceRow({
	balance,
	me,
	fmt,
	last
}: {
	balance: { id: string; name: string; netCents: number; former: boolean };
	me: string;
	fmt: (cents: number) => string;
	last: boolean;
}) {
	const tags = [
		balance.id === me ? copy.expenses.youTag : null,
		balance.former ? copy.expenses.formerTag : null
	]
		.filter(Boolean)
		.join(' · ');
	const amount = `${balance.netCents > 0 ? '+' : ''}${fmt(balance.netCents)}`;
	return (
		<GroupedRow
			last={last}
			leading={<Avatar name={balance.name} />}
			accessible
			accessibilityLabel={[balance.name, tags, amount].filter(Boolean).join(', ')}
			trailing={
				<Text
					style={{
						...type.body,
						fontWeight: '600',
						color: balance.netCents > 0 ? color.accentInk : color.dangerInk
					}}
				>
					{amount}
				</Text>
			}
		>
			<Text style={type.body}>{balance.name}</Text>
			{tags ? <Text style={type.faint}>{tags}</Text> : null}
		</GroupedRow>
	);
}

function TransferRow({
	transfer,
	fmt,
	busy,
	onSettle,
	last
}: {
	transfer: Transfer;
	fmt: (cents: number) => string;
	busy: boolean;
	onSettle: () => void;
	last: boolean;
}) {
	const amount = fmt(transfer.amountCents);
	return (
		<GroupedRow
			last={last}
			trailing={
				<>
					<Text style={type.body}>{amount}</Text>
					<Pressable
						disabled={busy}
						accessibilityRole="button"
						accessibilityLabel={copy.expenses.settleRow.markPaidLabel(
							transfer.from,
							transfer.to,
							amount
						)}
						onPress={onSettle}
						style={{
							borderRadius: 999,
							backgroundColor: color.accentSoft,
							paddingHorizontal: space.md,
							paddingVertical: 6,
							marginLeft: space.xs,
							opacity: busy ? 0.45 : 1
						}}
					>
						<Text style={{ ...type.footnote, color: color.accentInk, fontWeight: '600' }}>
							{busy ? copy.expenses.settleRow.busyLabel : copy.expenses.settleRow.markPaid}
						</Text>
					</Pressable>
				</>
			}
		>
			<Text style={type.body}>
				{transfer.from} {copy.expenses.settleRow.pays} {transfer.to}
			</Text>
		</GroupedRow>
	);
}

const styles = StyleSheet.create({
	stats: {
		flexDirection: 'row',
		gap: space.lg,
		paddingHorizontal: rowInset,
		paddingVertical: space.md
	},
	titleLine: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs + 2 },
	title: { ...type.body, fontWeight: '600', flexShrink: 1 },
	// One body line tall, so a mark centres on the description's first line.
	mark: { height: type.body.lineHeight, justifyContent: 'center' },
	amount: { alignItems: 'flex-end', marginLeft: space.xs },
	amountText: { ...type.body, fontWeight: '600', fontVariant: ['tabular-nums'] },
	// The web's text-micro (0.72rem) in ink-faint, medium weight.
	micro: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: color.inkFaint }
});
