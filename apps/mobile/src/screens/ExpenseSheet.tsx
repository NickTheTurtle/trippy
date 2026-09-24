import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { currencyName } from '@trippy/core/currency-names';
import { copy } from '@trippy/copy';
import { formatMoney } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { CheckBox, Picker, SearchablePicker } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { SheetFooter } from '../ui/SheetFooter';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { color, fieldLabel, radius, space, type } from '../theme';
import { parseAmount } from '../lib/amount';

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
	spent_on: string;
	created_at: number;
	home_cents: number;
	converted: boolean;
	shares: Record<string, number>;
	parts: { userId: string; weight: number }[];
	version: number;
	needsReview: boolean;
};
export type Transfer = {
	fromId: string;
	toId: string;
	from: string;
	to: string;
	amountCents: number;
	token: string;
};
export type ExpensesData = {
	currency: string;
	currencies: string[];
	firstDay: string;
	lastDay: string;
	members: Member[];
	expenses: Expense[];
	balances: { id: string; name: string; netCents: number; former: boolean }[];
	settlement: Transfer[];
	me: string;
};

const MODES: { key: SplitMode; label: string }[] = [
	{ key: 'even', label: copy.expenses.addDialog.modes.even.label },
	{ key: 'shares', label: copy.expenses.addDialog.modes.shares.label },
	{ key: 'exact', label: copy.expenses.addDialog.modes.exact.label }
];

function today(): string {
	return new Date().toLocaleDateString('en-CA');
}

function currencyOptions(currencies: readonly string[]) {
	return currencies.map((code) => ({ key: code, label: code, detail: currencyName(code) }));
}

export function ExpenseSheet({
	open,
	tripId,
	data,
	expense,
	onClose,
	onSaved,
	onConflict
}: {
	open: boolean;
	tripId: string;
	data: ExpensesData;
	expense: Expense | null;
	onClose: () => void;
	onSaved: () => void;
	onConflict: () => void;
}) {
	const [description, setDescription] = useState('');
	const [spentOn, setSpentOn] = useState('');
	const [amount, setAmount] = useState('');
	const [currency, setCurrency] = useState(data.currency);
	const [payerId, setPayerId] = useState(data.me);
	const [mode, setMode] = useState<SplitMode>('even');
	const [chosen, setChosen] = useState<string[]>([]);
	const [weights, setWeights] = useState<Record<string, string>>({});
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		if (!open) return;
		if (expense) {
			setDescription(expense.description);
			setSpentOn(expense.spent_on);
			setAmount((expense.amount_cents / 100).toFixed(2));
			setCurrency(expense.currency);
			setPayerId(expense.payer_id);
			setMode(expense.split_mode);
			const currentMemberIds = new Set(data.members.map((m) => m.id));
			const currentParts = expense.parts.filter((p) => currentMemberIds.has(p.userId));
			setChosen(currentParts.map((p) => p.userId));
			setWeights(
				Object.fromEntries(
					currentParts.map((p) => [
						p.userId,
						expense.split_mode === 'exact' ? (p.weight / 100).toFixed(2) : String(p.weight)
					])
				)
			);
		} else {
			const now = today();
			setDescription('');
			setSpentOn(now >= data.firstDay && now <= data.lastDay ? now : data.firstDay);
			setAmount('');
			setCurrency(data.currency);
			setPayerId(data.me);
			setMode('even');
			setChosen(data.members.map((m) => m.id));
			setWeights({});
		}
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, expense?.id]);

	const totalCents = Math.round((parseAmount(amount) || 0) * 100);
	const absCents = Math.abs(totalCents);
	const income = totalCents < 0;
	const chosenMembers = data.members.filter((m) => chosen.includes(m.id));

	function weightOf(id: string): number {
		const raw = parseAmount(weights[id] ?? '');
		if (!Number.isFinite(raw) || raw <= 0) return 0;
		return mode === 'exact' ? Math.round(raw * 100) : raw;
	}

	const preview = useMemo(() => {
		const empty = new Map<string, number>();
		if (chosenMembers.length === 0 || mode === 'exact') return empty;
		const weightsForSplit = chosenMembers.map((m) => (mode === 'even' ? 1 : weightOf(m.id)));
		if (mode === 'shares' && weightsForSplit.every((w) => w <= 0)) return empty;
		const shares = splitByWeight(totalCents, weightsForSplit);
		return new Map(chosenMembers.map((m, i) => [m.id, shares[i]]));
	}, [chosenMembers, mode, totalCents, weights]);

	const exactSum = mode === 'exact' ? chosenMembers.reduce((sum, m) => sum + weightOf(m.id), 0) : 0;
	const exactOff = mode === 'exact' ? absCents - exactSum : 0;

	function pickMode(next: SplitMode) {
		if (next === mode) return;
		setMode(next);
		if (next === 'even') return setWeights({});
		if (next === 'shares')
			return setWeights(Object.fromEntries(chosenMembers.map((m) => [m.id, '1'])));
		const shares = splitByWeight(absCents, new Array(chosenMembers.length).fill(1));
		setWeights(
			Object.fromEntries(chosenMembers.map((m, i) => [m.id, (shares[i] / 100).toFixed(2)]))
		);
	}

	function toggle(id: string) {
		setChosen((current) => {
			if (current.includes(id)) return current.filter((x) => x !== id);
			if (mode === 'shares') setWeights((w) => ({ ...w, [id]: w[id] ?? '1' }));
			return [...current, id];
		});
	}

	function bumpShares(id: string, by: number) {
		setWeights((current) => {
			const now = Number(current[id]);
			const next = Math.max(1, (Number.isFinite(now) && now > 0 ? now : 1) + by);
			return { ...current, [id]: String(next) };
		});
	}

	function splitRest() {
		const blanks = chosenMembers.filter((m) => weightOf(m.id) === 0);
		const rest = absCents - exactSum;
		if (blanks.length === 0 || rest <= 0) return;
		const shares = splitByWeight(rest, new Array(blanks.length).fill(1));
		setWeights((current) => {
			const next = { ...current };
			blanks.forEach((m, i) => (next[m.id] = (shares[i] / 100).toFixed(2)));
			return next;
		});
	}

	const save = useMutation(
		async () => {
			const value = parseAmount(amount);
			if (!Number.isFinite(value) || Math.round(value * 100) === 0) {
				throw new ApiError(400, copy.common.amountMissing);
			}
			const currentChosen = data.members.filter((m) => chosen.includes(m.id)).map((m) => m.id);
			try {
				await api(`/trips/${tripId}/expenses${expense ? `/${expense.id}` : ''}`, {
					method: expense ? 'PUT' : 'POST',
					body: {
						description,
						spentOn,
						amount: value,
						currency,
						payerId,
						splitMode: mode,
						participantIds: currentChosen,
						weights: Object.fromEntries(
							currentChosen.map((id) => [id, parseAmount(weights[id] ?? '') || 0])
						),
						version: expense?.version
					}
				});
			} catch (err) {
				if (err instanceof ApiError && err.status === 409) onConflict();
				throw err;
			}
		},
		{ fallback: copy.expenses.addDialog.fallback, onSuccess: onSaved }
	);

	const remove = useMutation(
		async () => {
			if (!expense) return;
			await api(`/trips/${tripId}/expenses/${expense.id}`, { method: 'DELETE' });
		},
		{
			fallback: copy.expenses.addDialog.fallback,
			onSuccess: () => {
				setConfirmDelete(false);
				onSaved();
			}
		}
	);

	const title = expense
		? income
			? copy.expenses.addDialog.editIncomeTitle
			: copy.expenses.addDialog.editExpenseTitle
		: income
			? copy.expenses.addDialog.incomeTitle
			: copy.expenses.addDialog.expenseTitle;

	return (
		<>
			<Sheet open={open && !confirmDelete} title={title} onClose={onClose}>
				<Field
					label={copy.expenses.addDialog.descriptionLabel}
					value={description}
					onChangeText={setDescription}
				/>
				<Field
					label={copy.expenses.addDialog.dateLabel}
					value={spentOn}
					onChangeText={setSpentOn}
					autoCapitalize="none"
				/>
				<Field
					label={copy.expenses.addDialog.amountLabel}
					value={amount}
					onChangeText={setAmount}
					keyboardType="numbers-and-punctuation"
				/>
				<SearchablePicker
					label={copy.expenses.addDialog.currencyLabel}
					value={currency}
					options={currencyOptions(data.currencies)}
					onPick={setCurrency}
					noMatches={copy.ui.currencyPicker.noMatches}
				/>
				<Picker
					label={
						income ? copy.expenses.addDialog.receivedByLabel : copy.expenses.addDialog.paidByLabel
					}
					options={data.members.map((m) => ({ key: m.id, label: m.name }))}
					value={payerId}
					onPick={setPayerId}
				/>
				<Text style={{ ...type.faint, color: income ? color.accentInk : color.inkFaint }}>
					{income ? copy.expenses.addDialog.incomeNote : copy.expenses.addDialog.expenseNote}
				</Text>
				<Picker
					label={copy.expenses.addDialog.splitLabel}
					options={MODES}
					value={mode}
					onPick={(key) => pickMode(key as SplitMode)}
				/>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
					<Text style={{ ...type.faint, flex: 1 }}>
						{copy.expenses.addDialog.selectedCount(chosen.length, data.members.length)}
						{mode === 'exact' && absCents !== 0
							? exactOff === 0
								? copy.expenses.addDialog.fullyAllocated
								: copy.expenses.addDialog.remainder(
										formatMoney(Math.abs(exactOff), currency),
										exactOff > 0
									)
							: ''}
					</Text>
					{mode === 'exact' ? (
						<SmallAction label={copy.expenses.addDialog.splitTheRest} onPress={splitRest} />
					) : null}
					<SmallAction
						label={copy.expenses.addDialog.all}
						onPress={() => {
							const ids = data.members.map((m) => m.id);
							setChosen(ids);
							if (mode === 'shares') {
								setWeights((current) => ({
									...Object.fromEntries(ids.map((id) => [id, current[id] ?? '1'])),
									...current
								}));
							}
						}}
					/>
					<SmallAction label={copy.expenses.addDialog.none} onPress={() => setChosen([])} />
				</View>
				<View style={{ gap: space.sm }}>
					{data.members.map((m) => {
						const on = chosen.includes(m.id);
						const money =
							on && totalCents !== 0 && preview.has(m.id)
								? formatMoney(preview.get(m.id) ?? 0, currency)
								: null;
						return (
							<View
								key={m.id}
								style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 }}
							>
								<CheckBox checked={on} label={m.name} onPress={() => toggle(m.id)} />
								<Text style={{ ...type.body, flex: 1 }}>{m.name}</Text>
								{money && mode === 'shares' ? <Text style={type.faint}>{money}</Text> : null}
								{on && mode === 'shares' ? (
									<Stepper
										value={weights[m.id] ?? ''}
										name={m.name}
										onMinus={() => bumpShares(m.id, -1)}
										onPlus={() => bumpShares(m.id, 1)}
										onChange={(v) => setWeights((w) => ({ ...w, [m.id]: v }))}
									/>
								) : null}
								{on && mode === 'exact' ? (
									<View style={{ width: 94 }}>
										<Field
											label=""
											value={weights[m.id] ?? ''}
											onChangeText={(v) => setWeights((w) => ({ ...w, [m.id]: v }))}
											keyboardType="decimal-pad"
											accessibilityLabel={copy.expenses.addDialog.weightLabel(true, m.name)}
											style={{ height: 34, textAlign: 'right' }}
										/>
									</View>
								) : null}
								{money && mode === 'even' ? <Text style={type.faint}>{money}</Text> : null}
							</View>
						);
					})}
				</View>
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={expense ? copy.common.save : copy.common.add}
					primaryBusyLabel={expense ? copy.common.saving : copy.common.adding}
					primaryBusy={save.busy}
					primaryDisabled={!description.trim() || chosen.length === 0}
					onPrimary={() => void save.run()}
					destructiveLabel={expense ? copy.common.deleteLabel(expense.description) : undefined}
					onDestructive={expense ? () => setConfirmDelete(true) : undefined}
				/>
			</Sheet>
			<ConfirmSheet
				open={!!expense && confirmDelete}
				title={expense ? copy.common.deleteTitle(expense.description) : ''}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}

export function PaymentSheet({
	open,
	tripId,
	payment,
	home,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	payment: Expense | null;
	home: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [spentOn, setSpentOn] = useState('');
	const [confirmDelete, setConfirmDelete] = useState(false);
	useEffect(() => {
		if (!open || !payment) return;
		setSpentOn(payment.spent_on);
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, payment?.id]);
	const save = useMutation(
		() =>
			api(`/trips/${tripId}/expenses/${payment?.id}/date`, { method: 'PUT', body: { spentOn } }),
		{ fallback: copy.expenses.addDialog.fallback, onSuccess: onSaved }
	);
	const remove = useMutation(
		() => api(`/trips/${tripId}/expenses/${payment?.id}`, { method: 'DELETE' }),
		{
			fallback: copy.expenses.addDialog.fallback,
			onSuccess: () => {
				setConfirmDelete(false);
				onSaved();
			}
		}
	);
	if (!payment) return null;
	return (
		<>
			<Sheet open={open && !confirmDelete} title={payment.description} onClose={onClose}>
				<Text style={type.head}>{formatMoney(payment.amount_cents, payment.currency)}</Text>
				{payment.converted ? (
					<Text style={type.faint}>≈ {formatMoney(payment.home_cents, home)}</Text>
				) : null}
				<Field
					label={copy.expenses.addDialog.dateLabel}
					value={spentOn}
					onChangeText={setSpentOn}
					autoCapitalize="none"
				/>
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={copy.common.save}
					primaryBusyLabel={copy.common.saving}
					primaryBusy={save.busy}
					onPrimary={() => void save.run()}
					destructiveLabel={copy.common.deleteLabel(payment.description)}
					onDestructive={() => setConfirmDelete(true)}
				/>
			</Sheet>
			<ConfirmSheet
				open={confirmDelete}
				title={copy.common.deleteTitle(payment.description)}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}

function SmallAction({ label, onPress }: { label: string; onPress: () => void }) {
	return (
		<Pressable onPress={onPress} hitSlop={8}>
			<Text style={{ ...type.small, color: color.accent }}>{label}</Text>
		</Pressable>
	);
}

function Stepper({
	value,
	name,
	onMinus,
	onPlus,
	onChange
}: {
	value: string;
	name: string;
	onMinus: () => void;
	onPlus: () => void;
	onChange: (value: string) => void;
}) {
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
			<Round
				label="−"
				accessibilityLabel={copy.expenses.addDialog.fewerShares(name)}
				onPress={onMinus}
			/>
			<View style={{ width: 48 }}>
				<Field
					label=""
					value={value}
					onChangeText={onChange}
					keyboardType="decimal-pad"
					accessibilityLabel={copy.expenses.addDialog.weightLabel(false, name)}
					style={{ height: 34, textAlign: 'center' }}
				/>
			</View>
			<Round
				label="+"
				accessibilityLabel={copy.expenses.addDialog.moreShares(name)}
				onPress={onPlus}
			/>
		</View>
	);
}

function Round({
	label,
	accessibilityLabel,
	onPress
}: {
	label: string;
	accessibilityLabel: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
			onPress={onPress}
			style={{
				width: 30,
				height: 30,
				borderRadius: 15,
				borderWidth: 1,
				borderColor: color.line,
				alignItems: 'center',
				justifyContent: 'center'
			}}
		>
			<Text style={type.body}>{label}</Text>
		</Pressable>
	);
}
