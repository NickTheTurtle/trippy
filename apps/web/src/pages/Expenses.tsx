import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { formatMoney } from '../lib/format';
import { useTrip } from './TripShell';
import SectionNav, { type SectionItem } from '../components/ui/SectionNav';
import FormError from '../components/ui/FormError';
import EmptyState from '../components/ui/EmptyState';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import type { Expense, ExpensesData } from './expenses/types';
import ExpenseRow from './expenses/ExpenseRow';
import SettleRow from './expenses/SettleRow';
import AddExpense from './expenses/AddExpense';
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
				ariaLabel={ce.navAriaLabel}
			/>

			<div className="min-w-0">
				{section === 'expenses' && (
					<>
						<Head text={ce.ledgerHead}>
							<button className="btn primary" onClick={() => setShowAdd(true)}>
								{ce.addExpense}
							</button>
						</Head>
						<div className="card px-5 py-5">
							{data.expenses.length === 0 ? (
								<EmptyState
									message={ce.emptyMessage}
									action={
										<button className="btn" type="button" onClick={() => setShowAdd(true)}>
											{ce.emptyAction}
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
						<Head text={ce.balancesHead(data.currency)} />
						<div className="card px-5 py-5">
							{unsettled === 0 ? (
								<p className="muted m-0 text-[0.9rem]">{ce.allEven}</p>
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
													<span className="muted ml-1.5 text-[0.75rem]">{ce.youTag}</span>
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
						<Head text={ce.settleHead} />
						<div className="card px-5 py-5">
							{data.settlement.length === 0 ? (
								<p className="muted m-0 text-[0.9rem]">{ce.nothingToSettle}</p>
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
				title={
					pendingDelete
						? pendingDelete.settlement === 1
							? ce.deletePaymentTitle(pendingDelete.description)
							: ce.deleteExpenseTitle(pendingDelete.description)
						: ''
				}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
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

function Head({ text, children }: { text: string; children?: React.ReactNode }) {
	return (
		<div className="mb-4 flex min-h-phead flex-wrap items-center justify-between gap-4">
			<p className="muted m-0 min-w-0">{text}</p>
			{children}
		</div>
	);
}
