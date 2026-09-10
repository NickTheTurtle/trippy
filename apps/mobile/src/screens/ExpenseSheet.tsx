import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { SplitMode } from '@trippy/core/split';
import { copy } from '@trippy/copy';
import { formatMoney } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { CheckBox, Picker } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { color, space, type } from '../theme';

export type Member = { id: string; name: string };
export type Expense = {
	id: string;
	description: string;
	payer_name: string;
	payer_id: string;
	amount_cents: number;
	currency: string;
	split_mode: SplitMode;
	participants: number;
	settlement: number;
	created_at: number;
	home_cents: number;
	converted: boolean;
	shares: Record<string, number>;
	parts: { userId: string; weight: number }[];
	/** Bumped on every save; sent back on edit so a stale write is refused. */
	version: number;
	/** Somebody on this expense has left the trip and their share is unresolved. */
	needsReview: boolean;
};
export type Transfer = {
	fromId: string;
	toId: string;
	from: string;
	to: string;
	amountCents: number;
	/** Idempotency key for `POST /expenses/settle`. */
	token: string;
};
export type ExpensesData = {
	currency: string;
	currencies: string[];
	members: Member[];
	expenses: Expense[];
	/** `former` marks a departed member who still has money in the trip. */
	balances: { id: string; name: string; netCents: number; former: boolean }[];
	settlement: Transfer[];
	me: string;
};

const MODES: { key: SplitMode; label: string }[] = [
	{ key: 'even', label: copy.expenses.addDialog.modes.even.label },
	{ key: 'shares', label: copy.expenses.addDialog.modes.shares.label },
	{ key: 'exact', label: copy.expenses.addDialog.modes.exact.label }
];

/**
 * Adding or editing one expense.
 *
 * The split picker follows the web dialog's rule exactly: changing the mode
 * seeds the weights so every mode starts out reproducing Evenly, which means a
 * mode switch changes nothing until something is typed and the form is never
 * left in a state the server would refuse.
 */
export function ExpenseSheet({
	open,
	tripId,
	data,
	expense,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	data: ExpensesData;
	expense: Expense | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [description, setDescription] = useState('');
	const [amount, setAmount] = useState('');
	const [currency, setCurrency] = useState(data.currency);
	const [payerId, setPayerId] = useState(data.me);
	const [mode, setMode] = useState<SplitMode>('even');
	const [chosen, setChosen] = useState<string[]>([]);
	const [weights, setWeights] = useState<Record<string, string>>({});

	useEffect(() => {
		if (!open) return;
		if (expense) {
			setDescription(expense.description);
			setAmount((expense.amount_cents / 100).toFixed(2));
			setCurrency(expense.currency);
			setPayerId(expense.payer_id);
			setMode(expense.split_mode);
			setChosen(expense.parts.map((p) => p.userId));
			setWeights(
				Object.fromEntries(
					expense.parts.map((p) => [
						p.userId,
						expense.split_mode === 'exact' ? (p.weight / 100).toFixed(2) : String(p.weight)
					])
				)
			);
		} else {
			setDescription('');
			setAmount('');
			setCurrency(data.currency);
			setPayerId(data.me);
			setMode('even');
			setChosen(data.members.map((m) => m.id));
			setWeights({});
		}
	}, [open, expense, data.currency, data.me, data.members]);

	const cents = useMemo(() => {
		const value = Number(amount.trim());
		return Number.isFinite(value) ? Math.round(Math.abs(value) * 100) : 0;
	}, [amount]);

	/**
	 * A share count and a money amount are not interchangeable, so nothing typed
	 * carries between modes. Seeding is what makes the switch harmless: one share
	 * each, or an even slice each, both reproduce Evenly.
	 */
	function pickMode(next: SplitMode) {
		setMode(next);
		if (next === 'even') return setWeights({});
		if (next === 'shares') {
			return setWeights(Object.fromEntries(chosen.map((id) => [id, '1'])));
		}
		const each = chosen.length > 0 ? Math.floor(cents / chosen.length) : 0;
		const seeded = Object.fromEntries(chosen.map((id) => [id, (each / 100).toFixed(2)]));
		// The remainder goes to the first participant, so the seeded amounts add
		// up to the total and the form opens valid rather than a cent short.
		if (chosen.length > 0) {
			const remainder = cents - each * chosen.length;
			seeded[chosen[0]] = ((each + remainder) / 100).toFixed(2);
		}
		setWeights(seeded);
	}

	function toggle(id: string) {
		setChosen((c) => {
			if (c.includes(id)) return c.filter((x) => x !== id);
			// A newly ticked person in shares mode gets one share, so ticking
			// somebody never leaves them charging nothing.
			if (mode === 'shares') setWeights((w) => ({ ...w, [id]: w[id] ?? '1' }));
			return [...c, id];
		});
	}

	const save = useMutation(
		async () => {
			const value = Number(amount.trim());
			if (!Number.isFinite(value) || Math.round(value * 100) === 0) {
				throw new ApiError(400, 'Enter an amount.');
			}
			const body = {
				description,
				amount: value,
				currency,
				payerId,
				splitMode: mode,
				participantIds: chosen,
				weights: Object.fromEntries(
					chosen.map((id) => [id, Number(weights[id] ?? (mode === 'shares' ? 1 : 0))])
				),
				// The version this sheet opened on. The server refuses the write if
				// somebody else has saved since, because a split is a set two people
				// rewrote differently and "both applied" has no meaning for it.
				version: expense?.version
			};
			if (expense) {
				await api(`/trips/${tripId}/expenses/${expense.id}`, { method: 'PUT', body });
			} else {
				await api(`/trips/${tripId}/expenses`, { method: 'POST', body });
			}
			onSaved();
		},
		{ fallback: copy.expenses.addDialog.fallback }
	);

	const remove = useMutation(
		async () => {
			if (!expense) return;
			await api(`/trips/${tripId}/expenses/${expense.id}`, { method: 'DELETE' });
			onSaved();
		},
		{ fallback: copy.expenses.addDialog.fallback }
	);

	const income = Number(amount.trim()) < 0;
	const title = expense
		? income
			? copy.expenses.addDialog.editIncomeTitle
			: copy.expenses.addDialog.editExpenseTitle
		: income
			? copy.expenses.addDialog.incomeTitle
			: copy.expenses.addDialog.expenseTitle;

	const allocated = chosen.reduce((sum, id) => sum + Math.round(Number(weights[id] ?? 0) * 100), 0);

	return (
		<Sheet open={open} title={title} onClose={onClose}>
			<Field
				label={copy.expenses.addDialog.descriptionLabel}
				value={description}
				onChangeText={setDescription}
			/>
			<View style={{ flexDirection: 'row', gap: space.md }}>
				<View style={{ flex: 2 }}>
					<Field
						label={copy.expenses.addDialog.amountLabel}
						value={amount}
						onChangeText={setAmount}
						keyboardType="numbers-and-punctuation"
					/>
				</View>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.expenses.addDialog.currencyLabel}
						value={currency}
						onChangeText={(v) => setCurrency(v.toUpperCase())}
						autoCapitalize="characters"
						maxLength={3}
					/>
				</View>
			</View>

			<View style={{ gap: space.xs }}>
				<Text style={type.small}>
					{income ? copy.expenses.addDialog.receivedByLabel : copy.expenses.addDialog.paidByLabel}
				</Text>
				<Picker
					options={data.members.map((m) => ({ key: m.id, label: m.name }))}
					value={payerId}
					onPick={setPayerId}
				/>
			</View>

			<View style={{ gap: space.xs }}>
				<Text style={type.small}>{copy.expenses.addDialog.splitLabel}</Text>
				<Picker
					options={MODES.map((m) => ({ key: m.key, label: m.label }))}
					value={mode}
					onPick={(k) => pickMode(k as SplitMode)}
				/>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
					<Text style={{ ...type.faint, flex: 1 }}>
						{copy.expenses.addDialog.selectedCount(chosen.length, data.members.length)}
						{mode === 'exact'
							? allocated === cents
								? copy.expenses.addDialog.fullyAllocated
								: copy.expenses.addDialog.remainder(
										formatMoney(Math.abs(cents - allocated), currency),
										allocated < cents
									)
							: ''}
					</Text>
					<Pressable
						onPress={() =>
							setChosen(chosen.length === data.members.length ? [] : data.members.map((m) => m.id))
						}
						hitSlop={8}
					>
						<Text style={{ ...type.small, color: color.accent }}>
							{chosen.length === data.members.length
								? copy.expenses.addDialog.none
								: copy.expenses.addDialog.all}
						</Text>
					</Pressable>
				</View>
			</View>

			<View>
				{data.members.map((m) => {
					const on = chosen.includes(m.id);
					return (
						<View
							key={m.id}
							style={{
								flexDirection: 'row',
								alignItems: 'center',
								gap: space.md,
								height: 44,
								paddingHorizontal: space.sm
							}}
						>
							<CheckBox checked={on} label={m.name} onPress={() => toggle(m.id)} />
							<Text style={{ ...type.body, flex: 1 }}>{m.name}</Text>
							{on && mode !== 'even' ? (
								<View style={{ width: 96 }}>
									<Field
										label=""
										value={weights[m.id] ?? ''}
										onChangeText={(v) => setWeights((w) => ({ ...w, [m.id]: v }))}
										keyboardType="decimal-pad"
										style={{ height: 34, textAlign: 'right' }}
										accessibilityLabel={copy.expenses.addDialog.weightLabel(
											mode === 'exact',
											m.name
										)}
									/>
								</View>
							) : null}
						</View>
					);
				})}
			</View>

			<FormError message={save.error || remove.error} />
			<Button
				label={
					expense
						? copy.expenses.addDialog.saveChanges
						: income
							? copy.expenses.addDialog.saveIncome
							: copy.expenses.addDialog.saveExpense
				}
				onPress={() => void save.run()}
				busy={save.busy}
				disabled={!description.trim() || chosen.length === 0}
			/>
			{expense ? (
				<Button label="Delete" tone="danger" onPress={() => void remove.run()} busy={remove.busy} />
			) : null}
		</Sheet>
	);
}
