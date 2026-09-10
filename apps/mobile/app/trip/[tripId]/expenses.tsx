import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { formatMoney, formatTimestamp } from '@trippy/copy/format';
import { api } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { Card, EmptyState, FormError, Loading, Screen } from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { ExpenseSheet } from '../../../src/screens/ExpenseSheet';
import type { Expense, ExpensesData } from '../../../src/screens/ExpenseSheet';
import { color, space, type } from '../../../src/theme';

const SECTIONS = ['expenses', 'balances', 'settle'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * The ledger, the balances and the settlement, behind the same segmented
 * control Preparation uses. The web page stacks them; a phone would make the
 * settlement a long way down from the total it follows from.
 */
export default function Expenses() {
	const tripId = useTripId();
	const { data, error, loading, reload } = useApi<ExpensesData>(`/trips/${tripId}/expenses`);
	const [section, setSection] = useState<Section>('expenses');
	const [editing, setEditing] = useState<Expense | null>(null);
	const [adding, setAdding] = useState(false);

	const total = useMemo(
		() => (data ? data.expenses.reduce((sum, e) => sum + e.home_cents, 0) : 0),
		[data]
	);

	// The token carried on the suggestion makes this idempotent: a second press,
	// or a second person pressing at the same moment, collapses into one payment
	// instead of recording it twice and inverting the debt.
	const settle = useMutation(
		(fromId: string, toId: string, cents: number, token: string) =>
			api(`/trips/${tripId}/expenses/settle`, {
				method: 'POST',
				body: { fromId, toId, amountCents: cents, token }
			}),
		{ fallback: copy.expenses.settleRow.fallback, onSuccess: reload }
	);

	if (loading && !data) return <Loading />;
	if (!data) return <Screen>{error ? <FormError message={error} /> : null}</Screen>;

	const perPerson = data.members.length > 0 ? Math.round(total / data.members.length) : 0;
	const name = (id: string) => data.members.find((m) => m.id === id)?.name ?? '';

	return (
		<>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				{error ? <FormError message={error} /> : null}

				<Card>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
						<View style={{ flex: 1 }}>
							<Text style={type.faint}>{copy.expenses.tripTotal}</Text>
							<Text style={type.head}>{formatMoney(total, data.currency)}</Text>
						</View>
						<View style={{ flex: 1 }}>
							<Text style={type.faint}>{copy.expenses.perPerson}</Text>
							<Text style={type.head}>{formatMoney(perPerson, data.currency)}</Text>
						</View>
						<Pressable onPress={() => setAdding(true)} hitSlop={8}>
							<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
								{copy.expenses.addExpense}
							</Text>
						</Pressable>
					</View>
				</Card>

				<SegmentedControl
					items={SECTIONS.map((s) => ({ key: s, label: copy.expenses.sections[s] }))}
					active={section}
					onPick={(k) => setSection(k as Section)}
				/>

				{section === 'expenses' ? (
					<Card>
						{data.expenses.length === 0 ? (
							<EmptyState message="Nothing added yet" />
						) : (
							data.expenses.map((e, i) => (
								<Pressable
									key={e.id}
									onPress={() => (e.settlement > 0 ? undefined : setEditing(e))}
									style={{
										flexDirection: 'row',
										alignItems: 'center',
										gap: space.md,
										paddingVertical: space.sm,
										borderTopWidth: i === 0 ? 0 : 1,
										borderTopColor: color.line
									}}
								>
									<View style={{ flex: 1, gap: 2 }}>
										<Text style={type.body}>{e.description}</Text>
										<Text style={type.faint}>
											{name(e.payer_id)}{' '}
											{e.home_cents < 0 ? copy.expenses.row.received : copy.expenses.row.paid} ·{' '}
											{formatTimestamp(e.created_at)}
										</Text>
									</View>
									<Text style={type.small}>{formatMoney(e.home_cents, data.currency)}</Text>
								</Pressable>
							))
						)}
					</Card>
				) : null}

				{section === 'balances' ? (
					<Card>
						{data.balances.length === 0 ? (
							<EmptyState message={copy.expenses.allEven} />
						) : (
							data.balances.map((b, i) => (
								<View
									key={b.id}
									style={{
										flexDirection: 'row',
										alignItems: 'center',
										paddingVertical: space.sm,
										borderTopWidth: i === 0 ? 0 : 1,
										borderTopColor: color.line
									}}
								>
									<Text style={{ ...type.body, flex: 1 }}>
										{b.name}
										{b.id === data.me ? ` (${copy.expenses.youTag})` : ''}
									</Text>
									<Text
										style={{
											...type.small,
											color: b.netCents >= 0 ? color.accentInk : color.dangerInk
										}}
									>
										{formatMoney(b.netCents, data.currency)}
									</Text>
								</View>
							))
						)}
					</Card>
				) : null}

				{section === 'settle' ? (
					<Card>
						<FormError message={settle.error} />
						{data.settlement.length === 0 ? (
							<EmptyState message={copy.expenses.nothingToSettle} />
						) : (
							data.settlement.map((s, i) => (
								<View
									key={`${s.fromId}-${s.toId}`}
									style={{
										flexDirection: 'row',
										alignItems: 'center',
										gap: space.md,
										paddingVertical: space.sm,
										borderTopWidth: i === 0 ? 0 : 1,
										borderTopColor: color.line
									}}
								>
									<Text style={{ ...type.body, flex: 1 }}>
										{s.from} {copy.expenses.settleRow.pays} {s.to}
									</Text>
									<Text style={type.small}>{formatMoney(s.amountCents, data.currency)}</Text>
									<Pressable
										accessibilityRole="button"
										accessibilityLabel={copy.expenses.settleRow.markPaidLabel(
											s.from,
											s.to,
											formatMoney(s.amountCents, data.currency)
										)}
										onPress={() => void settle.run(s.fromId, s.toId, s.amountCents, s.token)}
										hitSlop={6}
									>
										<Text style={{ ...type.small, color: color.accent, fontWeight: '600' }}>
											{settle.busy
												? copy.expenses.settleRow.busyLabel
												: copy.expenses.settleRow.markPaid}
										</Text>
									</Pressable>
								</View>
							))
						)}
					</Card>
				) : null}
			</Screen>

			<ExpenseSheet
				open={adding || editing !== null}
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
			/>
		</>
	);
}
