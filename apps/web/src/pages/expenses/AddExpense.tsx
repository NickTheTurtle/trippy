import { useState } from 'react';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { formatMoney } from '../../lib/format';
import { currencyOptions } from '../../lib/currencies';
import Modal from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import { FieldShell } from '../../components/ui/Field';
import FormError from '../../components/ui/FormError';
import { LinkButton } from '../../components/ui/buttons';
import type { Member } from './types';

const MODES: { value: SplitMode; label: string; hint: string }[] = [
	{ value: 'even', label: 'Evenly', hint: 'Everyone selected pays the same.' },
	{
		value: 'shares',
		label: 'By shares',
		hint: 'Weight each person: 2 shares pays double.'
	},
	{ value: 'exact', label: 'By amount', hint: 'Type what each person owes.' }
];

/**
 * Logs one expense: the amount, who paid it, and how it is divided. The three
 * split modes and the live per-person preview are the bulk of it.
 */
export default function AddExpense({
	tripId,
	members,
	currencies,
	home,
	onClose,
	onSaved
}: {
	tripId: string;
	members: Member[];
	currencies: string[];
	home: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [description, setDescription] = useState('');
	const [amount, setAmount] = useState('');
	const [currency, setCurrency] = useState(home);
	const [payerId, setPayerId] = useState(members[0]?.id ?? '');
	const [splitMode, setSplitMode] = useState<SplitMode>('even');
	/** Who is in on this expense. Everyone is included by default. */
	const [picked, setPicked] = useState<Set<string>>(new Set(members.map((m) => m.id)));
	/** Per-person share count (`shares` mode) or amount (`exact` mode), as typed. */
	const [weights, setWeights] = useState<Record<string, string>>({});

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
	const canSave =
		description.trim() !== '' &&
		totalCents !== 0 &&
		chosen.length > 0 &&
		(splitMode === 'even' ||
			(splitMode === 'shares' && chosen.some((m) => weightOf(m.id) > 0)) ||
			(splitMode === 'exact' && exactOff === 0));

	/** A share count and an amount are not interchangeable, so start clean on a mode change. */
	function setMode(mode: SplitMode) {
		if (mode === splitMode) return;
		setSplitMode(mode);
		setWeights({});
	}

	function toggle(id: string) {
		setPicked((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
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
			await api(`/trips/${tripId}/expenses`, {
				method: 'POST',
				body: {
					description,
					amount: Number(amount),
					currency,
					payerId,
					splitMode,
					participantIds: chosen.map((m) => m.id),
					// The Svelte form flattened these into `w:<userId>` fields because
					// FormData has no nested values. JSON does, so send the map.
					weights: Object.fromEntries(chosen.map((m) => [m.id, Number(weights[m.id]) || 0]))
				}
			});
			onSaved();
			onClose();
		},
		{ fallback: 'Could not save that expense.' }
	);

	return (
		<Modal open title={income ? 'Add income' : 'Add expense'} onClose={onClose}>
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-4">
					{/* A 12-column grid, so the four top fields keep their proportions
					    instead of wrapping at hard pixel widths as the modal narrows. */}
					<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
						<FieldShell className="col-span-12" label="Description">
							<input
								autoFocus
								required
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								className="input"
							/>
						</FieldShell>
						<FieldShell className="col-span-4" label="Amount">
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
						<FieldShell className="col-span-3" label="Currency">
							<Select
								options={currencyOptions(currencies)}
								value={currency}
								onChange={setCurrency}
								ariaLabel="Currency"
							/>
						</FieldShell>
						<FieldShell className="col-span-5" label={income ? 'Received by' : 'Paid by'}>
							<Select
								options={members.map((m) => ({ value: m.id, label: m.name }))}
								value={payerId}
								onChange={setPayerId}
								ariaLabel="Paid by"
							/>
						</FieldShell>
					</div>

					<p className={`-mt-2 text-[0.82rem] ${income ? 'text-accent-ink' : 'text-ink-faint'}`}>
						{income
							? 'Saved as income: everyone selected is credited instead of charged.'
							: 'Use a negative amount for a refund or payout.'}
					</p>

					<div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3.5 py-3.5">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span className="text-[0.82rem] text-ink-soft">Split</span>
							<div
								role="group"
								aria-label="Split method"
								className="flex w-fit max-w-full flex-wrap gap-1 rounded-full border border-line bg-surface-2 p-1"
							>
								{MODES.map((o) => (
									<button
										key={o.value}
										type="button"
										aria-pressed={splitMode === o.value}
										onClick={() => setMode(o.value)}
										className={[
											'cursor-pointer rounded-full border-none px-3.5 py-1.5 text-[0.85rem] whitespace-nowrap',
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
						<p className="m-0 text-[0.82rem] text-ink-faint">
							{MODES.find((o) => o.value === splitMode)?.hint}
						</p>

						<div className="mt-1.5 mb-1.5 flex items-baseline justify-between gap-2.5">
							<span className="muted min-w-0 truncate text-[0.85rem]">
								{chosen.length} of {members.length} selected
								{splitMode === 'exact' &&
									totalCents !== 0 &&
									(exactOff === 0
										? ' · fully allocated'
										: ` · ${formatMoney(Math.abs(exactOff), currency)} ${exactOff > 0 ? 'left' : 'over'}`)}
							</span>
							<span className="flex flex-none gap-3">
								{splitMode === 'exact' && (
									<LinkButton onClick={autofillExact}>Split the rest</LinkButton>
								)}
								<LinkButton onClick={() => setPicked(new Set(members.map((m) => m.id)))}>
									All
								</LinkButton>
								<LinkButton onClick={() => setPicked(new Set())}>None</LinkButton>
							</span>
						</div>

						<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-4 gap-y-0.5 p-0">
							{members.map((m) => {
								const on = picked.has(m.id);
								return (
									<li
										key={m.id}
										className={[
											'flex items-center gap-2 rounded-sm px-1.5 py-1 text-[0.88rem]',
											on ? 'bg-surface shadow-[inset_0_0_0_1px_var(--color-line)]' : ''
										].join(' ')}
									>
										<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 select-none">
											<input
												type="checkbox"
												checked={on}
												onChange={() => toggle(m.id)}
												className="flex-none accent-accent"
											/>
											<span className="truncate" title={m.name}>
												{m.name}
											</span>
										</label>
										{on && splitMode !== 'even' && (
											<input
												type="number"
												min="0"
												step={splitMode === 'exact' ? '0.01' : '1'}
												aria-label={`${splitMode === 'exact' ? 'Amount' : 'Shares'} for ${m.name}`}
												value={weights[m.id] ?? ''}
												onChange={(e) =>
													setWeights((prev) => ({
														...prev,
														[m.id]: e.target.value
													}))
												}
												className="input compact w-[4.6rem] flex-none text-right"
											/>
										)}
										{on && totalCents !== 0 && preview.has(m.id) && (
											<span
												className={`flex-none text-[0.78rem] tabular-nums ${income ? 'text-accent-ink' : 'text-ink-faint'}`}
											>
												{formatMoney(preview.get(m.id) ?? 0, currency)}
											</span>
										)}
									</li>
								);
							})}
						</ul>
					</div>
				</div>

				<div className="mfoot">
					<FormError message={save.error} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={!canSave || save.busy}>
						{save.busy ? 'Saving...' : income ? 'Save income' : 'Save expense'}
					</button>
				</div>
			</form>
		</Modal>
	);
}
