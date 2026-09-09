import { useState } from 'react';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { api } from '../api';
import { useApi } from '../useApi';
import { useLiveSection } from '../useTripEvents';
import { useMutation } from '../useMutation';
import { formatMoney, formatTimestamp } from '../format';
import { currencyOptions } from '../currencies';
import { useTrip } from './TripShell';
import Modal from '../components/Modal';
import Select from '../components/Select';
import SectionNav, { type SectionItem } from '../components/SectionNav';
import { FieldShell } from '../components/Field';
import FormError from '../components/FormError';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import { IconButton, LinkButton } from '../components/buttons';

type Member = { id: string; name: string };
type Expense = {
	id: string;
	description: string;
	payer_name: string;
	amount_cents: number;
	currency: string;
	split_mode: SplitMode;
	participants: number;
	settlement: number;
	created_at: number;
	home_cents: number;
	converted: boolean;
};
type Data = {
	currency: string;
	currencies: string[];
	members: Member[];
	expenses: Expense[];
	/** `netCents` is the exact figure; the major-unit `net` beside it is a shim. */
	balances: { id: string; name: string; netCents: number }[];
	settlement: Transfer[];
	me: string;
};
type Transfer = { fromId: string; toId: string; from: string; to: string; amountCents: number };

function splitLabel(mode: SplitMode, n: number): string {
	const people = `${n} ${n === 1 ? 'way' : 'ways'}`;
	if (mode === 'shares') return `split by shares, ${people}`;
	if (mode === 'exact') return `split by amount, ${people}`;
	return `split ${people}`;
}

export default function Expenses() {
	const { trip } = useTrip();
	const { data, error, reload } = useApi<Data>(`/trips/${trip.id}/expenses`);
	// Balances move when the roster does, not only when an expense changes.
	useLiveSection(['expenses', 'members', 'trip'], reload);
	const [section, setSection] = useState('expenses');
	const [showAdd, setShowAdd] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<Expense | null>(null);

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	// Compared in whole cents, so a balance is either zero or it is not; the old
	// 0.01 epsilon existed only because the figure arrived as a float.
	const owed = data.balances.filter((b) => b.netCents > 0);
	const owes = data.balances.filter((b) => b.netCents < 0);
	const unsettled = owed.length + owes.length;
	const fmt = (cents: number) => formatMoney(cents, data.currency);

	const sections: SectionItem[] = [
		{ id: 'expenses', label: 'Expenses', badge: data.expenses.length },
		{
			id: 'balances',
			label: 'Balances',
			badge: unsettled === 0 ? '✓' : unsettled
		},
		{ id: 'settle', label: 'Settle up', badge: data.settlement.length || '✓' }
	];

	/**
	 * Records a suggested transfer as paid. It lands in the ledger as an ordinary
	 * expense, so the list of remaining transfers is recomputed from the same
	 * numbers and this row disappears from it.
	 *
	 * Sent as `amountCents`, which is the figure settlement is computed in: a
	 * major-unit amount has to be multiplied and rounded again on the way in, and
	 * a cent lost there leaves a balance that will not clear.
	 */
	async function settleUp(fromId: string, toId: string, amountCents: number) {
		await api(`/trips/${trip.id}/expenses/settle`, {
			method: 'POST',
			body: { fromId, toId, amountCents }
		});
		reload();
	}

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<SectionNav
				items={sections}
				value={section}
				onChange={setSection}
				ariaLabel="Expense sections"
			/>

			<div className="min-w-0">
				{section === 'expenses' && (
					<>
						<Head text="Log who paid. Use a negative amount for a refund or payout.">
							<button className="btn primary" onClick={() => setShowAdd(true)}>
								+ Add expense
							</button>
						</Head>
						<div className="card px-5 py-5">
							{data.expenses.length === 0 ? (
								<EmptyState
									message="No expenses yet."
									hint="Log the first one."
									action={
										<button className="btn" type="button" onClick={() => setShowAdd(true)}>
											Add expense
										</button>
									}
								/>
							) : (
								<ul className="m-0 flex list-none flex-col gap-3 p-0">
									{data.expenses.map((e) => (
										<ExpenseRow
											key={e.id}
											expense={e}
											home={data.currency}
											onRemove={() => setPendingDelete(e)}
										/>
									))}
								</ul>
							)}
						</div>
					</>
				)}

				{section === 'balances' && (
					<>
						<Head text={`Net position per person, in ${data.currency}.`} />
						<div className="card px-5 py-5">
							{unsettled === 0 ? (
								<p className="muted m-0 text-[0.9rem]">Everyone is even.</p>
							) : (
								<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-5 gap-y-1.5 p-0">
									{/* Creditors first, then debtors: the question people open
									    this for is "who am I paying", and a mixed list makes
									    that harder to scan than two blocks does. */}
									{[...owed, ...owes].map((b) => (
										<li key={b.id} className="flex justify-between gap-2.5 text-[0.9rem]">
											<span className="truncate" title={b.name}>
												{b.name}
												{/* The reader's own number is the one they came for, and
												    twenty names in three columns is too many to find it in. */}
												{b.id === data.me && (
													<span className="muted ml-1.5 text-[0.75rem]">you</span>
												)}
											</span>
											<span
												className={`shrink-0 font-semibold ${b.netCents > 0 ? 'text-accent-ink' : 'text-danger-ink'}`}
											>
												{b.netCents > 0 ? '+' : ''}
												{fmt(b.netCents)}
											</span>
										</li>
									))}
								</ul>
							)}
						</div>
					</>
				)}

				{section === 'settle' && (
					<>
						<Head text="Minimum transfers to clear all balances." />
						<div className="card px-5 py-5">
							{data.settlement.length === 0 ? (
								<p className="muted m-0 text-[0.9rem]">Nothing to settle.</p>
							) : (
								<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-1.5 p-0">
									{data.settlement.map((t) => (
										<SettleRow
											key={t.fromId + t.toId}
											t={t}
											fmt={fmt}
											onSettle={() => settleUp(t.fromId, t.toId, t.amountCents)}
										/>
									))}
								</ul>
							)}
						</div>
					</>
				)}
			</div>

			{showAdd && (
				<AddExpense
					tripId={trip.id}
					members={data.members}
					currencies={data.currencies}
					home={data.currency}
					onClose={() => setShowAdd(false)}
					onSaved={reload}
				/>
			)}

			{/* Deleting used to happen on the first click and, worse, threw into
			    nothing when the server refused: the row stayed put with no message.
			    The dialog both asks and is where the refusal lands. */}
			<ConfirmDialog
				open={!!pendingDelete}
				title={pendingDelete?.settlement === 1 ? 'Delete this payment?' : 'Delete this expense?'}
				confirmLabel="Delete"
				busyLabel="Deleting..."
				body={pendingDelete && <DeleteBody expense={pendingDelete} home={data.currency} />}
				onCancel={() => setPendingDelete(null)}
				onConfirm={async () => {
					if (!pendingDelete) return;
					await api(`/trips/${trip.id}/expenses/${pendingDelete.id}`, { method: 'DELETE' });
					setPendingDelete(null);
					reload();
				}}
			/>
		</div>
	);
}

/**
 * What deleting one row takes with it. Its participant rows cascade and the
 * balances are recomputed from what is left, so the honest consequence is that
 * everyone's balance moves; nothing else in the trip refers to an expense.
 */
function DeleteBody({ expense: e, home }: { expense: Expense; home: string }) {
	return (
		<>
			<p className="m-0 mb-2 font-semibold [overflow-wrap:anywhere]">{e.description}</p>
			<p className="m-0 text-[0.9rem]">
				{formatMoney(e.amount_cents, e.currency)}
				{e.converted ? ` (≈ ${formatMoney(e.home_cents, home)})` : ''}, {e.payer_name}
				{e.amount_cents < 0 ? ' received' : ' paid'}, {formatTimestamp(e.created_at)}.{' '}
				{e.settlement === 1
					? 'The balance it cleared comes back.'
					: 'Everyone on it has their balance recalculated.'}
			</p>
		</>
	);
}

function Head({ text, children }: { text: string; children?: React.ReactNode }) {
	return (
		<div className="mb-4 flex min-h-phead flex-wrap items-center justify-between gap-4">
			<p className="muted m-0 min-w-0">{text}</p>
			{children}
		</div>
	);
}

/**
 * One suggested transfer, with the button that records it as paid.
 *
 * Marking it paid is not destructive and is undone by deleting the expense it
 * writes, so it takes one click rather than a confirmation. The button reports
 * its own failure in place: the alternative, a banner at the top of a grid of
 * twenty rows, would not say which one failed.
 */
function SettleRow({
	t,
	fmt,
	onSettle
}: {
	t: Transfer;
	fmt: (cents: number) => string;
	onSettle: () => Promise<void>;
}) {
	const mark = useMutation(onSettle, { fallback: 'Could not record that payment.' });

	return (
		<li className="flex flex-col gap-1 rounded-[10px] bg-surface-2 px-2.5 py-2 text-[0.92rem]">
			<div className="flex items-center gap-2">
				<span className="truncate font-semibold" title={t.from}>
					{t.from}
				</span>
				<span className="shrink-0 text-[0.82rem] text-ink-faint">pays</span>
				<span className="truncate" title={t.to}>
					{t.to}
				</span>
				<span className="ml-auto font-semibold">{fmt(t.amountCents)}</span>
				<button
					className="btn small flex-none"
					disabled={mark.busy}
					onClick={() => void mark.run()}
					aria-label={`Record that ${t.from} paid ${t.to} ${fmt(t.amountCents)}`}
				>
					{mark.busy ? 'Saving' : 'Mark paid'}
				</button>
			</div>
			<FormError message={mark.error} className="text-[0.8rem]" />
		</li>
	);
}

function ExpenseRow({
	expense: e,
	home,
	onRemove
}: {
	expense: Expense;
	home: string;
	onRemove: () => void;
}) {
	const credit = e.amount_cents < 0;
	const settled = e.settlement === 1;
	return (
		<li className="flex items-center gap-3">
			<span
				className={`grid size-[30px] flex-none place-items-center rounded-full text-[0.82rem] font-semibold ${
					credit ? 'bg-surface-2 text-ink-soft' : 'bg-accent-soft text-accent-ink'
				}`}
			>
				{e.payer_name[0]}
			</span>
			<div className="flex min-w-0 flex-col">
				<span className="truncate text-[0.93rem] font-medium" title={e.description}>
					{e.description}
					{/* A settlement is an expense in every way that matters to the maths,
					    but it is not a cost anyone shared, so the ledger says which it is. */}
					{(credit || settled) && (
						<span className="ml-1 rounded-full border border-accent-soft px-1.5 py-px text-[0.66rem] font-semibold tracking-wider text-accent-ink uppercase">
							{settled ? 'payment' : 'income'}
						</span>
					)}
				</span>
				<span className="muted truncate text-[0.8rem]">
					{/* The description of a settlement already names both sides, so
					    repeating the payer and calling it a one-way split is noise. */}
					{settled ? (
						formatTimestamp(e.created_at)
					) : (
						<>
							{e.payer_name} {credit ? 'received' : 'paid'} ·{' '}
							{splitLabel(e.split_mode, e.participants)} · {formatTimestamp(e.created_at)}
						</>
					)}
				</span>
			</div>
			<span
				className={`ml-auto flex flex-col items-end text-right font-semibold ${credit ? 'text-accent-ink' : ''}`}
			>
				{formatMoney(e.amount_cents, e.currency)}
				{e.converted && (
					<span className="muted text-[0.75rem] font-medium">
						≈ {formatMoney(e.home_cents, home)}
					</span>
				)}
			</span>
			<IconButton label={`Delete ${e.description}`} danger className="flex-none" onClick={onRemove}>
				×
			</IconButton>
		</li>
	);
}

const MODES: { value: SplitMode; label: string; hint: string }[] = [
	{ value: 'even', label: 'Evenly', hint: 'Everyone selected pays the same.' },
	{
		value: 'shares',
		label: 'By shares',
		hint: 'Weight each person: 2 shares pays double.'
	},
	{ value: 'exact', label: 'By amount', hint: 'Type what each person owes.' }
];

function AddExpense({
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
