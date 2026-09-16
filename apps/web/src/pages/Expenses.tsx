import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { formatMoney } from '../lib/format';
import { useTrip } from './TripShell';
import { useNarrowLayout } from '../hooks/useMediaQuery';
import SectionNav, { type SectionItem } from '../components/ui/SectionNav';
import FormError from '../components/ui/FormError';
import EmptyState from '../components/ui/EmptyState';
import Stat from '../components/ui/Stat';
import ViewAsBar, { shareLabel } from '../components/ui/ViewAsBar';
import { PlusIcon, WarningIcon } from '../components/ui/icons';
import type { Expense, ExpensesData } from './expenses/types';
import ExpenseRow from './expenses/ExpenseRow';
import SettleRow from './expenses/SettleRow';
import EditExpense from './expenses/EditExpense';
import PaymentDialog from './expenses/PaymentDialog';
import { copy } from '../copy';

const ce = copy.expenses;

/**
 * Expenses: the ledger, the balances it nets out to, and the transfers that
 * clear them, as three sections of one page.
 *
 * This file is composition only. The two row types and the add dialog live in
 * `pages/expenses/`; the settlement maths lives in `@trippy/core`.
 */
export default function Expenses() {
	const { trip } = useTrip();
	const { data, error, reload } = useApi<ExpensesData>(`/trips/${trip.id}/expenses`);
	// Balances move when the roster does, not only when an expense changes.
	useLiveSection(['expenses', 'members', 'trip'], reload);
	const [section, setSection] = useState('expenses');
	/** Open dialog: `{ expense: null }` adds, `{ expense }` edits. Null is closed. */
	const [editing, setEditing] = useState<{ expense: Expense | null } | null>(null);
	/** The settlement whose dialog is open. */
	const [payment, setPayment] = useState<Expense | null>(null);
	/** Whose money the ledger is read as. '' is the whole trip. */
	const [viewAs, setViewAs] = useState('');
	const narrow = useNarrowLayout();

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	// Compared in whole cents, so a balance is either zero or it is not; the old
	// 0.01 epsilon existed only because the figure arrived as a float.
	const owed = data.balances.filter((b) => b.netCents > 0);
	const owes = data.balances.filter((b) => b.netCents < 0);
	const unsettled = owed.length + owes.length;
	const fmt = (cents: number) => formatMoney(cents, data.currency);

	// A settlement is a transfer between two members, not money the trip spent,
	// so it is in the ledger but out of both totals. Counting it would make the
	// trip look more expensive every time somebody paid a friend back.
	const spend = data.expenses.filter((e) => e.settlement !== 1);
	const spent = spend.reduce((n, e) => n + e.home_cents, 0);
	const perPerson = data.members.length ? Math.round(spent / data.members.length) : spent;
	const mine = viewAs ? spend.reduce((n, e) => n + (e.shares[viewAs] ?? 0), 0) : 0;

	// Read as one person, the ledger keeps the rows that charge them, plus the
	// payments they made. A row somebody else paid and nobody split with them
	// costs them nothing, and a list of zeroes is not an answer.
	const shown = viewAs
		? data.expenses.filter(
				(e) => e.shares[viewAs] !== undefined || (e.settlement === 1 && e.payer_id === viewAs)
			)
		: data.expenses;

	const sections: SectionItem[] = [
		{ id: 'expenses', label: ce.sections.expenses, badge: data.expenses.length },
		{
			id: 'balances',
			label: ce.sections.balances,
			badge: unsettled === 0 ? '✓' : unsettled
		},
		{ id: 'settle', label: ce.sections.settle, badge: data.settlement.length || '✓' }
	];

	/**
	 * Records a suggested transfer as paid. It lands in the ledger as an ordinary
	 * expense, so the list of remaining transfers is recomputed from the same
	 * numbers and this row disappears from it.
	 *
	 * Sent as `amountCents`, which is the figure settlement is computed in: a
	 * major-unit amount has to be multiplied and rounded again on the way in, and
	 * a cent lost there leaves a balance that will not clear.
	 *
	 * The `token` carried on the suggestion makes the write idempotent. It is
	 * derived from the balances the suggestion was computed from, so two members
	 * looking at the same screen send the same one and their presses collapse
	 * into a single payment; once it lands the balances move, so a genuinely
	 * repeated payment later carries a different token and is recorded.
	 */
	async function settleUp(
		fromId: string,
		toId: string,
		amountCents: number,
		token: string | undefined
	) {
		await api(`/trips/${trip.id}/expenses/settle`, {
			method: 'POST',
			body: { fromId, toId, amountCents, token }
		});
		reload();
	}

	const addExpense = (
		<button type="button" className="btn primary" onClick={() => setEditing({ expense: null })}>
			<PlusIcon />
			{ce.addExpense}
		</button>
	);

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<SectionNav
				items={sections}
				value={section}
				onChange={setSection}
				ariaLabel={ce.navAriaLabel}
				// Balances and Settle up have nothing to add, so the dropdown stands
				// alone there rather than carrying a button that belongs to one of the
				// three sections.
				action={section === 'expenses' ? addExpense : null}
			/>

			<div className="min-w-0">
				{section === 'expenses' && (
					<>
						{/* Narrow the row carries the two figures alone, because the Add
						    has gone up beside the section dropdown. An empty ledger has no
						    figures worth printing, and the row is not free: its band and
						    its `mb-4` pushed the empty panel 53.6px below where the same
						    panel sits on Balances and Settle up, so switching sections on
						    a trip with nothing in it stepped the card up and down. Wide it
						    always renders, because the Add button lives in it. */}
						{(!narrow || data.expenses.length > 0) && (
							<Head
								left={
									<div className="flex min-w-0 flex-wrap items-end gap-6">
										<Stat label={ce.tripTotal} value={fmt(spent)} />
										<Stat
											label={viewAs ? shareLabel(data.members, viewAs, data.me) : ce.perPerson}
											value={fmt(viewAs ? mine : perPerson)}
										/>
									</div>
								}
							>
								{!narrow && addExpense}
							</Head>
						)}
						<div className="card overflow-hidden p-0">
							{data.expenses.length > 0 && (
								<ViewAsBar
									members={data.members}
									me={data.me}
									value={viewAs}
									onChange={setViewAs}
								/>
							)}
							{shown.length === 0 ? (
								<EmptyState graphic message={copy.common.nothingAdded} />
							) : (
								<ul className="m-0 flex list-none flex-col gap-3 px-5 py-5">
									{shown.map((e) => (
										<ExpenseRow
											key={e.id}
											expense={e}
											home={data.currency}
											share={viewAs && e.settlement !== 1 ? (e.shares[viewAs] ?? 0) : undefined}
											// A settlement has nothing to edit, so its dialog states the
											// payment and offers only the delete.
											onOpen={() =>
												e.settlement === 1 ? setPayment(e) : setEditing({ expense: e })
											}
										/>
									))}
								</ul>
							)}
						</div>
					</>
				)}

				{section === 'balances' && (
					<>
						{/* Empty, the card is unpadded: the empty state is the panel and
						    carries its own padding, the same as on the list tab. */}
						<div className={`card ${unsettled === 0 ? '' : 'px-5 py-5'}`}>
							{unsettled === 0 ? (
								<EmptyState message={ce.allEven} />
							) : (
								<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-5 gap-y-1.5 p-0">
									{/* Creditors first, then debtors: the question people open
									    this for is "who am I paying", and a mixed list makes
									    that harder to scan than two blocks does. */}
									{[...owed, ...owes].map((b) => (
										<li key={b.id} className="flex justify-between gap-2.5 text-body">
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="truncate" title={b.name}>
													{b.name}
												</span>
												{/* The reader's own number is the one they came for, and
												    twenty names in three columns is too many to find it in. */}
												{b.id === data.me && <span className="muted text-micro">{ce.youTag}</span>}
												{/* Someone who has left but still has money in the trip.
												    Marked rather than spelled out: the words took more
												    room in a three-column list than the name they were
												    about, and this is the same sign the ledger already
												    uses for a row that needs attention. Siblings of the
												    name rather than inside it, so a long name truncates
												    and the marks do not go with it. */}
												{b.former && (
													<span
														role="img"
														aria-label={ce.formerTag}
														title={ce.formerTag}
														className="flex flex-none text-warn"
													>
														<WarningIcon />
													</span>
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
						<div className={`card ${data.settlement.length === 0 ? '' : 'px-5 py-5'}`}>
							{data.settlement.length === 0 ? (
								<EmptyState message={ce.nothingToSettle} />
							) : (
								<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-1.5 p-0">
									{data.settlement.map((t) => (
										<SettleRow
											key={t.fromId + t.toId}
											t={t}
											fmt={fmt}
											onSettle={() => settleUp(t.fromId, t.toId, t.amountCents, t.token)}
										/>
									))}
								</ul>
							)}
						</div>
					</>
				)}
			</div>

			{editing && (
				<EditExpense
					tripId={trip.id}
					expense={editing.expense}
					members={data.members}
					me={data.me}
					currencies={data.currencies}
					home={data.currency}
					onClose={() => setEditing(null)}
					onSaved={reload}
					onDelete={
						editing.expense
							? async () => {
									await api(`/trips/${trip.id}/expenses/${editing.expense!.id}`, {
										method: 'DELETE'
									});
									setEditing(null);
									reload();
								}
							: null
					}
				/>
			)}

			{payment && (
				<PaymentDialog
					payment={payment}
					home={data.currency}
					onClose={() => setPayment(null)}
					onDelete={async () => {
						await api(`/trips/${trip.id}/expenses/${payment.id}`, { method: 'DELETE' });
						setPayment(null);
						reload();
					}}
				/>
			)}
		</div>
	);
}

/**
 * The ledger opens with its two figures in line with "+ Add", the way
 * Preparation does. Balances and Settle up have no figure and no action, so
 * they open straight onto their card rather than reserving an empty band to
 * keep the three sections aligned: dead space at the top of two of the three
 * sections cost more than the alignment was worth. Narrow, the button has gone
 * up beside the section dropdown and this row carries the figures alone, so an
 * empty ledger does not render it at all: there is nothing left to put in it,
 * and the band was the only reason the empty panel sat lower there than the
 * identical panel on the other two sections.
 */
function Head({ left, children }: { left: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="mb-4 flex min-h-phead flex-wrap items-center justify-between gap-4">
			{left}
			{children}
		</div>
	);
}
