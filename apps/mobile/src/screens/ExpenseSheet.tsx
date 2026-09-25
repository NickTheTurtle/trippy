import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { currencyName } from '@trippy/core/currency-names';
import { copy } from '@trippy/copy';
import { formatMoney } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { DestructiveRow, Field, InsetGroupedList, InsetSection, ListRow } from '../ui';
import { DateField, SearchablePicker, SegmentedControl } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { AppSymbol } from '../ui/Symbol';
import { color, hairline, space, type } from '../theme';
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
const KINDS = [
	{ key: 'expense', label: copy.expenses.addDialog.kindExpense },
	{ key: 'income', label: copy.expenses.addDialog.kindIncome }
] as const;
type ExpenseKind = (typeof KINDS)[number]['key'];

type Option = { key: string; label: string; detail?: string };

function today(): string {
	return new Date().toLocaleDateString('en-CA');
}

function currencyOptions(currencies: readonly string[]) {
	return currencies.map((code) => ({ key: code, label: code, detail: currencyName(code) }));
}

function payerOptions(members: readonly Member[], expense: Expense | null): Option[] {
	const options = members.map((m) => ({ key: m.id, label: m.name }));
	if (!expense || members.some((m) => m.id === expense.payer_id)) return options;
	return [
		{
			key: expense.payer_id,
			label: expense.payer_name,
			detail: copy.expenses.formerTag
		},
		...options
	];
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
	const [expenseKind, setExpenseKind] = useState<ExpenseKind>('expense');
	const [currency, setCurrency] = useState(data.currency);
	const [payerId, setPayerId] = useState(data.me);
	const [mode, setMode] = useState<SplitMode>('even');
	const [chosen, setChosen] = useState<string[]>([]);
	const [weights, setWeights] = useState<Record<string, string>>({});
	const [confirmDelete, setConfirmDelete] = useState(false);

	const parsedAmount = parseAmount(amount);
	const amountMagnitude = Number.isFinite(parsedAmount) ? Math.abs(parsedAmount) : 0;
	const totalCents = Math.round(amountMagnitude * 100) * (expenseKind === 'income' ? -1 : 1);
	const absCents = Math.abs(totalCents);
	const income = expenseKind === 'income';
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
			const signedValue = Math.abs(value) * (expenseKind === 'income' ? -1 : 1);
			const currentChosen = data.members.filter((m) => chosen.includes(m.id)).map((m) => m.id);
			try {
				await api(`/trips/${tripId}/expenses${expense ? `/${expense.id}` : ''}`, {
					method: expense ? 'PUT' : 'POST',
					body: {
						description,
						spentOn,
						amount: signedValue,
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

	useEffect(() => {
		if (!open) return;
		if (expense) {
			const existingIncome = expense.amount_cents < 0;
			setDescription(expense.description);
			setSpentOn(expense.spent_on);
			setAmount((Math.abs(expense.amount_cents) / 100).toFixed(2));
			setExpenseKind(existingIncome ? 'income' : 'expense');
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
			setExpenseKind('expense');
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

	const title = expense
		? income
			? copy.expenses.addDialog.editIncomeTitle
			: copy.expenses.addDialog.editExpenseTitle
		: income
			? copy.expenses.addDialog.incomeTitle
			: copy.expenses.addDialog.expenseTitle;

	return (
		<>
			<Sheet
				open={open && !confirmDelete}
				title={title}
				onClose={onClose}
				onPrimary={() => void save.run()}
				primaryLabel={expense ? copy.common.save : copy.common.add}
				primaryBusyLabel={expense ? copy.common.saving : copy.common.adding}
				primaryBusy={save.busy}
				primaryDisabled={!description.trim() || chosen.length === 0}
				error={save.error}
			>
				<InsetSection>
					<Field
						variant="row"
						label={copy.expenses.addDialog.descriptionLabel}
						value={description}
						onChangeText={setDescription}
					/>
					<Field
						variant="row"
						label={copy.expenses.addDialog.amountLabel}
						value={amount}
						onChangeText={(value) => {
							if (value.trim().startsWith('-')) {
								setExpenseKind('income');
								setAmount(value.replace(/^-+/, ''));
							} else {
								setAmount(value);
							}
						}}
						keyboardType="numbers-and-punctuation"
					/>
					<SearchablePicker
						variant="row"
						label={copy.expenses.addDialog.currencyLabel}
						value={currency}
						options={currencyOptions(data.currencies)}
						onPick={setCurrency}
						noMatches={copy.ui.currencyPicker.noMatches}
					/>
					<DateField
						label={copy.expenses.addDialog.dateLabel}
						value={spentOn}
						onChange={setSpentOn}
						last
					/>
				</InsetSection>
				<InsetSection>
					<View style={{ padding: space.md }}>
						<SegmentedControl
							items={[...KINDS]}
							active={expenseKind}
							onPick={(key) => setExpenseKind(key as ExpenseKind)}
						/>
					</View>
				</InsetSection>
				<RowPicker
					label={
						income ? copy.expenses.addDialog.receivedByLabel : copy.expenses.addDialog.paidByLabel
					}
					value={payerId}
					options={payerOptions(data.members, expense)}
					onPick={setPayerId}
				/>
				<Text style={{ ...type.faint, color: income ? color.accentInk : color.inkFaint }}>
					{income ? copy.expenses.addDialog.incomeNote : copy.expenses.addDialog.mobileExpenseNote}
				</Text>
				<InsetSection title={copy.expenses.addDialog.splitLabel}>
					<View style={{ padding: space.md }}>
						<SegmentedControl
							items={MODES}
							active={mode}
							onPick={(key) => pickMode(key as SplitMode)}
						/>
					</View>
				</InsetSection>
				<ParticipantSection
					members={data.members}
					chosen={chosen}
					mode={mode}
					totalCents={totalCents}
					currency={currency}
					weights={weights}
					preview={preview}
					exactOff={exactOff}
					onToggle={toggle}
					onAll={() => {
						const ids = data.members.map((m) => m.id);
						setChosen(ids);
						if (mode === 'shares') {
							setWeights((current) => ({
								...current,
								...Object.fromEntries(ids.map((id) => [id, current[id] ?? '1']))
							}));
						}
					}}
					onNone={() => setChosen([])}
					onSplitRest={splitRest}
					onChangeWeight={(id, v) => setWeights((w) => ({ ...w, [id]: v }))}
					onBumpShares={bumpShares}
				/>
				{expense ? (
					<InsetSection>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(expense.description)}
							onPress={() => setConfirmDelete(true)}
						/>
					</InsetSection>
				) : null}
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
			<Sheet
				open={open && !confirmDelete}
				title={payment.description}
				onClose={onClose}
				onPrimary={() => void save.run()}
				primaryLabel={copy.common.save}
				primaryBusyLabel={copy.common.saving}
				primaryBusy={save.busy}
				error={save.error}
			>
				<InsetSection>
					<ListRow
						title={formatMoney(payment.amount_cents, payment.currency)}
						subtitle={payment.converted ? `≈ ${formatMoney(payment.home_cents, home)}` : undefined}
						accessory="none"
					/>
					<DateField
						label={copy.expenses.addDialog.dateLabel}
						value={spentOn}
						onChange={setSpentOn}
						last
					/>
				</InsetSection>
				<InsetSection>
					<DestructiveRow
						title={copy.common.delete}
						accessibilityLabel={copy.common.deleteLabel(payment.description)}
						onPress={() => setConfirmDelete(true)}
					/>
				</InsetSection>
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

function RowPicker({
	label,
	value,
	options,
	onPick
}: {
	label: string;
	value: string;
	options: Option[];
	onPick: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const current = options.find((option) => option.key === value);
	return (
		<InsetSection>
			<ListRow
				title={label}
				value={current?.label ?? value}
				onPress={() => setOpen((v) => !v)}
				accessory="chevron"
				last={!open}
			/>
			{open
				? options.map((option, index) => (
						<ListRow
							key={option.key}
							title={option.label}
							subtitle={option.detail}
							accessory={option.key === value ? 'checkmark' : 'none'}
							accessibilityState={{ selected: option.key === value }}
							onPress={() => {
								onPick(option.key);
								setOpen(false);
							}}
							last={index === options.length - 1}
						/>
					))
				: null}
		</InsetSection>
	);
}

function ParticipantSection({
	members,
	chosen,
	mode,
	totalCents,
	currency,
	weights,
	preview,
	exactOff,
	onToggle,
	onAll,
	onNone,
	onSplitRest,
	onChangeWeight,
	onBumpShares
}: {
	members: Member[];
	chosen: string[];
	mode: SplitMode;
	totalCents: number;
	currency: string;
	weights: Record<string, string>;
	preview: Map<string, number>;
	exactOff: number;
	onToggle: (id: string) => void;
	onAll: () => void;
	onNone: () => void;
	onSplitRest: () => void;
	onChangeWeight: (id: string, value: string) => void;
	onBumpShares: (id: string, by: number) => void;
}) {
	const footer =
		mode === 'exact' && Math.abs(totalCents) !== 0
			? exactOff === 0
				? copy.expenses.addDialog.fullyAllocatedMobile
				: copy.expenses.addDialog.remainderMobile(
						formatMoney(Math.abs(exactOff), currency),
						exactOff > 0
					)
			: undefined;
	return (
		<View style={{ gap: 7 }}>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: space.md,
					marginHorizontal: space.lg
				}}
			>
				<Text
					style={{
						...type.caption,
						textTransform: 'uppercase',
						letterSpacing: 0.35,
						flex: 1
					}}
				>
					{copy.expenses.addDialog.selectedCount(chosen.length, members.length)}
				</Text>
				{mode === 'exact' ? (
					<SmallAction label={copy.expenses.addDialog.splitTheRest} onPress={onSplitRest} />
				) : null}
				<SmallAction label={copy.expenses.addDialog.all} onPress={onAll} />
				<SmallAction label={copy.expenses.addDialog.none} onPress={onNone} />
			</View>
			<InsetGroupedList>
				{members.map((member, index) => {
					const on = chosen.includes(member.id);
					const money =
						on && totalCents !== 0 && preview.has(member.id)
							? formatMoney(preview.get(member.id) ?? 0, currency)
							: null;
					return (
						<View
							key={member.id}
							style={{
								minHeight: 52,
								flexDirection: 'row',
								alignItems: 'center',
								gap: space.md,
								paddingHorizontal: space.md,
								borderBottomWidth: index === members.length - 1 ? 0 : hairline,
								borderBottomColor: color.line
							}}
						>
							{/* Only the tick and name toggle. The stepper and amount input
							    sit beside it, not inside it: on iOS a pressable row is one
							    accessibility element, which hid them from VoiceOver. */}
							<Pressable
								accessibilityRole="checkbox"
								accessibilityState={{ checked: on }}
								accessibilityLabel={member.name}
								onPress={() => onToggle(member.id)}
								style={{
									flex: 1,
									flexDirection: 'row',
									alignItems: 'center',
									gap: space.md,
									alignSelf: 'stretch'
								}}
							>
								<CheckboxGlyph checked={on} />
								<Text style={{ ...type.body, flex: 1 }}>{member.name}</Text>
								{money && mode !== 'exact' ? <Text style={type.faint}>{money}</Text> : null}
							</Pressable>
							{on && mode === 'shares' ? (
								<Stepper
									value={weights[member.id] ?? ''}
									name={member.name}
									onMinus={() => onBumpShares(member.id, -1)}
									onPlus={() => onBumpShares(member.id, 1)}
									onChange={(v) => onChangeWeight(member.id, v)}
								/>
							) : null}
							{on && mode === 'exact' ? (
								<View style={{ width: 94 }}>
									<Field
										variant="bare"
										label=""
										value={weights[member.id] ?? ''}
										onChangeText={(v) => onChangeWeight(member.id, v)}
										keyboardType="decimal-pad"
										accessibilityLabel={copy.expenses.addDialog.weightLabel(true, member.name)}
										style={{ height: 34, textAlign: 'right' }}
									/>
								</View>
							) : null}
						</View>
					);
				})}
			</InsetGroupedList>
			{footer ? (
				<Text style={{ ...type.footnote, marginHorizontal: space.lg }}>{footer}</Text>
			) : null}
		</View>
	);
}

function CheckboxGlyph({ checked }: { checked: boolean }) {
	return (
		<View
			style={{
				width: 24,
				height: 24,
				borderRadius: 12,
				borderWidth: 1.5,
				borderColor: checked ? color.accent : color.line,
				backgroundColor: checked ? color.accent : color.surface,
				alignItems: 'center',
				justifyContent: 'center'
			}}
		>
			{checked ? <AppSymbol name="checkmark" fallback="checkmark" size={15} color="#fff" /> : null}
		</View>
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
					variant="bare"
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
