import { useState } from 'react';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { currencySymbol, formatMoney } from '../../lib/format';
import { currencyOptions } from '../../lib/currencies';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import Select from '../../components/ui/Select';
import { FieldShell } from '../../components/ui/Field';
import { IconButton, LinkButton } from '../../components/ui/buttons';
import { MinusIcon, PlusIcon } from '../../components/ui/icons';
import { CheckBox } from '../../components/ui/CheckBox';
import type { Expense, Member } from './types';
import { copy } from '../../copy';

const c = copy.expenses.addDialog;

const MODES: { value: SplitMode; label: string }[] = [
	{ value: 'even', label: c.modes.even.label },
	{ value: 'shares', label: c.modes.shares.label },
	{ value: 'exact', label: c.modes.exact.label }
];

/**
 * Adds or edits one expense: the amount, who paid it, and how it is divided.
 * The three split modes and the live per-person preview are the bulk of it.
 * `expense` null means adding.
 */
export default function EditExpense({
	tripId,
	expense,
	members,
	me,
	currencies,
	home,
	onClose,
	onSaved,
	onDelete
}: {
	tripId: string;
	expense: Expense | null;
	members: Member[];
	me: string;
	currencies: string[];
	home: string;
	onClose: () => void;
	onSaved: () => void;
	/** Null when adding: there is nothing yet to delete. */
	onDelete?: (() => void | Promise<void>) | null;
}) {
	const [description, setDescription] = useState(expense?.description ?? '');
	const del = useDeleteAction({
		title: copy.expenses.deleteExpenseTitle(expense?.description ?? ''),
		busyLabel: copy.common.deleting,
		onDelete
	});
	const [amount, setAmount] = useState(expense ? (expense.amount_cents / 100).toFixed(2) : '');
	const [currency, setCurrency] = useState(expense?.currency ?? home);
	// A new expense is paid by you until you say otherwise. `members[0]` is the
	// organizer, because the roster is ordered by role, so defaulting to it
	// meant everyone but the organizer silently logged their own spending
	// against somebody else.
	const [payerId, setPayerId] = useState(expense?.payer_id ?? me ?? members[0]?.id ?? '');
	const [splitMode, setSplitMode] = useState<SplitMode>(expense?.split_mode ?? 'even');
	/** Who is in on this expense. Everyone is included by default. */
	const [picked, setPicked] = useState<Set<string>>(
		new Set(expense ? expense.parts.map((p) => p.userId) : members.map((m) => m.id))
	);
	/** Per-person share count (`shares` mode) or amount (`exact` mode), as typed. */
	const [weights, setWeights] = useState<Record<string, string>>(() =>
		// Stored weights are share counts in `shares` and cents in `exact`, which
		// is what the two inputs expect back in their own units. `even` has no
		// input, and its stored 1s would be meaningless in either.
		expense && expense.split_mode !== 'even'
			? Object.fromEntries(
					expense.parts.map((p) => [
						p.userId,
						expense.split_mode === 'exact' ? (p.weight / 100).toFixed(2) : String(p.weight)
					])
				)
			: {}
	);

	const totalCents = Math.round((Number(amount) || 0) * 100);
	/** A negative amount is money coming back to the group: a refund or payout. */
	const income = totalCents < 0;
	const chosen = members.filter((m) => picked.has(m.id));

	function weightOf(id: string): number {
		const raw = Number(weights[id]);
		if (!Number.isFinite(raw) || raw <= 0) return 0;
		return splitMode === 'exact' ? Math.round(raw * 100) : raw;
	}

	/** Live preview of what each selected person owes, in cents. */
	// Not memoised: it is a handful of integer divisions over the member list,
	// and every input it depends on changes on almost every keystroke anyway.
	const preview = (() => {
		const empty = new Map<string, number>();
		// In `exact` mode the typed number is the share, so the input already
		// shows it; only `even` and `shares` need a computed preview.
		if (chosen.length === 0 || splitMode === 'exact') return empty;
		const w = chosen.map((m) => (splitMode === 'even' ? 1 : weightOf(m.id)));
		if (splitMode === 'shares' && w.every((v) => v <= 0)) return empty;
		const cents = splitByWeight(totalCents, w);
		return new Map(chosen.map((m, i) => [m.id, cents[i]]));
	})();

	/**
	 * In `exact` mode the typed amounts must add up to the total. They are always
	 * entered as positive magnitudes, so compare against `|total|`; an income
	 * entry of -60 is still "three people at 20 each".
	 */
	const exactSum = splitMode === 'exact' ? chosen.reduce((a, m) => a + weightOf(m.id), 0) : 0;
	const exactOff = splitMode === 'exact' ? Math.abs(totalCents) - exactSum : 0;

	/**
	 * Switching mode seeds every selected person, so the form is valid and says
	 * something true the moment it is switched into.
	 *
	 * A share count and a money amount are not interchangeable, so nothing typed
	 * in one mode carries into another. Starting blank instead was the worse of
	 * the two: `shares` read "everyone is in" while dividing by nothing, and
	 * `exact` opened on a form that had to be filled in before it would save.
	 * One share each and an even slice each are both exactly what `Evenly`
	 * already does, so the switch changes nothing until something is typed.
	 */
	function setMode(mode: SplitMode) {
		if (mode === splitMode) return;
		setSplitMode(mode);
		if (mode === 'even') return setWeights({});
		if (mode === 'shares') {
			return setWeights(Object.fromEntries(chosen.map((m) => [m.id, '1'])));
		}
		const each = splitByWeight(Math.abs(totalCents), new Array(chosen.length).fill(1));
		setWeights(Object.fromEntries(chosen.map((m, i) => [m.id, (each[i] / 100).toFixed(2)])));
	}

	function toggle(id: string) {
		const on = picked.has(id);
		setPicked((prev) => {
			const next = new Set(prev);
			if (on) next.delete(id);
			else next.add(id);
			return next;
		});
		// Somebody ticked on in `shares` starts on one share rather than on none:
		// a ticked box that charges nothing is the trap this whole seeding avoids.
		if (!on && splitMode === 'shares' && !weights[id]) {
			setWeights((prev) => ({ ...prev, [id]: '1' }));
		}
	}

	/** Step one person's share count, never below one. */
	function bumpShares(id: string, by: number) {
		setWeights((prev) => {
			const now = Number(prev[id]);
			const next = Math.max(1, (Number.isFinite(now) && now > 0 ? now : 1) + by);
			return { ...prev, [id]: String(next) };
		});
	}

	/** Give everyone still blank an even slice of what is left to allocate. */
	function autofillExact() {
		const blanks = chosen.filter((m) => weightOf(m.id) === 0);
		const rest = Math.abs(totalCents) - exactSum;
		if (blanks.length === 0 || rest <= 0) return;
		const each = splitByWeight(rest, new Array(blanks.length).fill(1));
		setWeights((prev) => {
			const next = { ...prev };
			blanks.forEach((m, i) => (next[m.id] = (each[i] / 100).toFixed(2)));
			return next;
		});
	}

	const save = useMutation(
		async () => {
			await api(`/trips/${tripId}/expenses${expense ? `/${expense.id}` : ''}`, {
				method: expense ? 'PUT' : 'POST',
				body: {
					description,
					amount: Number(amount),
					currency,
					payerId,
					splitMode,
					participantIds: chosen.map((m) => m.id),
					// The Svelte form flattened these into `w:<userId>` fields because
					// FormData has no nested values. JSON does, so send the map.
					weights: Object.fromEntries(chosen.map((m) => [m.id, Number(weights[m.id]) || 0])),
					// The version this form opened on. The server refuses the write if
					// someone else has saved since, because a split is a set two people
					// rewrote differently and "both applied" has no meaning for it.
					version: expense?.version
				}
			});
			onSaved();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<>
			<Modal
				open={!del.asking}
				title={
					expense
						? income
							? c.editIncomeTitle
							: c.editExpenseTitle
						: income
							? c.incomeTitle
							: c.expenseTitle
				}
				onClose={onClose}
			>
				<ModalForm onSubmit={save.submit}>
					<div className="mbody flex flex-col gap-4">
						{/* A 12-column grid, so the four top fields keep their proportions
					    instead of wrapping at hard pixel widths as the modal narrows.
					    On a phone the proportions themselves change: at a third of a
					    337px modal the currency Select had room for "U...". */}
						<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
							<FieldShell className="col-span-12" label={c.descriptionLabel}>
								<input
									autoFocus
									required
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									className="input"
								/>
							</FieldShell>
							<FieldShell className="col-span-6 sm:col-span-4" label={c.amountLabel}>
								<input
									type="number"
									step="0.01"
									inputMode="decimal"
									required
									value={amount}
									onChange={(e) => setAmount(e.target.value)}
									className="input"
								/>
							</FieldShell>
							<FieldShell className="col-span-6 sm:col-span-3" label={c.currencyLabel}>
								<Select
									options={currencyOptions(currencies)}
									value={currency}
									onChange={setCurrency}
									ariaLabel={c.currencyLabel}
								/>
							</FieldShell>
							<FieldShell
								className="col-span-12 sm:col-span-5"
								label={income ? c.receivedByLabel : c.paidByLabel}
							>
								<Select
									options={members.map((m) => ({ value: m.id, label: m.name }))}
									value={payerId}
									onChange={setPayerId}
									ariaLabel={income ? c.receivedByLabel : c.paidByLabel}
								/>
							</FieldShell>
						</div>

						<p className={`-mt-2 text-meta ${income ? 'text-accent-ink' : 'text-ink-faint'}`}>
							{income ? c.incomeNote : c.expenseNote}
						</p>

						<div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 px-3.5 py-3.5">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<span className="text-meta text-ink-soft">{c.splitLabel}</span>
								<div
									role="group"
									aria-label={c.splitAriaLabel}
									/* `flex-none` and no `w-fit` so a narrow modal moves the whole
								   control onto its own line under the label. Either of those
								   let it shrink on the label's line instead and wrap its own
								   buttons, splitting three segments into a two-and-one block.
								   `max-w-full` still caps it if the labels are genuinely too
								   wide for the modal. */
									className="flex max-w-full flex-none flex-wrap gap-1 rounded-full border border-line bg-surface-2 p-1"
								>
									{MODES.map((o) => (
										<button
											key={o.value}
											type="button"
											aria-pressed={splitMode === o.value}
											onClick={() => setMode(o.value)}
											className={[
												'cursor-pointer rounded-full border-none px-3 py-1.5 text-meta whitespace-nowrap sm:px-3.5',
												splitMode === o.value
													? 'bg-surface font-medium text-ink shadow-sm'
													: 'bg-transparent text-ink-soft'
											].join(' ')}
										>
											{o.label}
										</button>
									))}
								</div>
							</div>
							<div className="mt-2 mb-2 flex items-baseline justify-between gap-2.5">
								<span className="muted min-w-0 truncate text-meta">
									{c.selectedCount(chosen.length, members.length)}
									{splitMode === 'exact' &&
										totalCents !== 0 &&
										(exactOff === 0
											? c.fullyAllocated
											: c.remainder(formatMoney(Math.abs(exactOff), currency), exactOff > 0))}
								</span>
								<span className="flex flex-none gap-3">
									{splitMode === 'exact' && (
										<LinkButton onClick={autofillExact}>{c.splitTheRest}</LinkButton>
									)}
									<LinkButton onClick={() => setPicked(new Set(members.map((m) => m.id)))}>
										{c.all}
									</LinkButton>
									<LinkButton onClick={() => setPicked(new Set())}>{c.none}</LinkButton>
								</span>
							</div>

							{/* One column as soon as a row carries an input: a stepper or a
						    money field beside a name cannot be squeezed into a 230px
						    track without the name truncating to nothing. */}
							<ul
								className={`m-0 grid list-none gap-x-4 gap-y-1.5 p-0 ${
									splitMode === 'even'
										? 'grid-cols-[repeat(auto-fill,minmax(230px,1fr))]'
										: 'grid-cols-1'
								}`}
							>
								{members.map((m) => {
									const on = picked.has(m.id);
									const money = on && totalCents !== 0 && preview.has(m.id) && (
										<span
											className={`w-[5.5rem] flex-none text-right text-meta tabular-nums ${income ? 'text-accent-ink' : 'text-ink-faint'}`}
										>
											{formatMoney(preview.get(m.id) ?? 0, currency)}
										</span>
									);
									return (
										<li
											key={m.id}
											/* A fixed height, because only two of the three modes draw an
										   input: without it the whole list jumps shorter the moment
										   somebody switches to Evenly. */
											className={[
												'flex h-11 items-center gap-2.5 rounded-md px-3 text-body',
												on ? 'bg-surface shadow-[inset_0_0_0_1px_var(--color-line)]' : ''
											].join(' ')}
										>
											<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 select-none">
												<CheckBox checked={on} onChange={() => toggle(m.id)} />
												<span className="truncate" title={m.name}>
													{m.name}
												</span>
											</label>
											{/* In shares mode the money reads as the answer to the share
										    count, so it sits before the stepper: left to right the row
										    says who, how much, and then the control that changes it.
										    The other modes have nothing to read it against and keep it
										    at the end of the row. */}
											{splitMode === 'shares' && money}
											{/* Shares are stepped, not typed: the common edits are "one
										    more" and "double", and a bare number box asked for a
										    keyboard to say either. */}
											{on && splitMode === 'shares' && (
												<span className="flex flex-none items-center gap-1">
													<IconButton
														label={c.fewerShares(m.name)}
														onClick={() => bumpShares(m.id, -1)}
													>
														<MinusIcon />
													</IconButton>
													<input
														type="number"
														min="1"
														step="1"
														aria-label={c.weightLabel(false, m.name)}
														value={weights[m.id] ?? ''}
														onChange={(e) =>
															setWeights((prev) => ({ ...prev, [m.id]: e.target.value }))
														}
														className="input compact stepped w-[3.2rem] text-center"
													/>
													<IconButton
														label={c.moreShares(m.name)}
														onClick={() => bumpShares(m.id, 1)}
													>
														<PlusIcon />
													</IconButton>
												</span>
											)}
											{on && splitMode === 'exact' && (
												<span className="relative flex-none">
													<span className="muted pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-meta">
														{currencySymbol(currency)}
													</span>
													<input
														type="number"
														min="0"
														step="0.01"
														inputMode="decimal"
														aria-label={c.weightLabel(true, m.name)}
														value={weights[m.id] ?? ''}
														onChange={(e) =>
															setWeights((prev) => ({ ...prev, [m.id]: e.target.value }))
														}
														className="input compact w-[6.5rem] pl-7 text-right"
													/>
												</span>
											)}
											{splitMode !== 'shares' && money}
										</li>
									);
								})}
							</ul>
						</div>
					</div>

					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={expense ? copy.common.saving : copy.common.adding}
						submitLabel={expense ? copy.common.save : copy.common.add}
						start={del.button}
					/>
				</ModalForm>
			</Modal>
			{del.confirm}
		</>
	);
}
