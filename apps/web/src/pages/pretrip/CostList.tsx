import { useState } from 'react';
import EmptyState from '../../components/ui/EmptyState';
import ViewAsBar, { shareLabel } from '../../components/ui/ViewAsBar';
import { IconButton } from '../../components/ui/buttons';
import { ChevronIcon, PencilIcon, TrashIcon } from '../../components/ui/icons';
import type { CostItem } from './types';
import { amountFor, isFor } from './shares';
import { formatMoney } from '../../lib/format';
import { cap } from './labels';
import { copy } from '../../copy';

const c = copy.preparation.costTable;
const cv = copy.viewAs;

/**
 * The estimates, one collapsible section per category.
 *
 * A flat table sorted by nothing in particular made the question people
 * actually ask, "what is the lodging going to run to", something you answered
 * by reading every row. The sections carry that answer in their headers, and
 * fold away once it has been read. The four categories are a fixed vocabulary,
 * so an empty one is still listed, at zero: its absence would read as a
 * category that does not exist rather than one nothing has been put in yet.
 *
 * "View as" answers the other question, "what is this trip going to cost *me*".
 * A line with people on it is split between them, and a line with nobody on it
 * is the whole trip's, so every member has a share of it.
 */
export default function CostList({
	items,
	categories,
	members,
	me,
	memberCount,
	viewAs,
	onViewAs,
	total,
	fmt,
	home,
	onEdit,
	onRemove
}: {
	items: CostItem[];
	categories: string[];
	members: { id: string; name: string }[];
	me: string;
	memberCount: number;
	/** A member id, or '' for the whole trip. */
	viewAs: string;
	onViewAs: (value: string) => void;
	total: number;
	fmt: (cents: number) => string;
	/** The trip's home currency, which `fmt` renders in. */
	home: string;
	onEdit: (it: CostItem) => void;
	onRemove: (it: CostItem) => void;
}) {
	const [shut, setShut] = useState<Set<string>>(new Set());
	const toggle = (cat: string) =>
		setShut((prev) => {
			const next = new Set(prev);
			if (!next.delete(cat)) next.add(cat);
			return next;
		});

	const shown = viewAs ? items.filter((it) => isFor(it, viewAs)) : items;
	/** Home-currency cents, which is what every subtotal is built from. */
	const amount = (it: CostItem) => amountFor(it, viewAs, memberCount);
	const converted = (it: CostItem) => !!it.currency && it.currency !== home;
	return (
		<div className="card overflow-hidden p-0">
			{items.length > 0 && (
				<ViewAsBar members={members} me={me} value={viewAs} onChange={onViewAs} />
			)}

			{items.length === 0 ? (
				<EmptyState graphic message={copy.common.nothingAdded} />
			) : (
				categories.map((cat) => {
					const rows = shown.filter((it) => it.category === cat);
					const subtotal = rows.reduce((n, it) => n + amount(it), 0);
					const open = rows.length > 0 && !shut.has(cat);

					return (
						<section key={cat} className="border-b border-line last:border-b-0">
							{/* An empty category has nothing to disclose, so it is a line of
							    text rather than a control that opens onto nothing. */}
							{rows.length === 0 ? (
								<div className="flex items-center gap-3 px-5 py-2.5 text-[0.92rem] text-ink-faint">
									<span className="size-3.5 flex-none" />
									<span>{cap(cat)}</span>
									<span className="ml-auto tabular-nums">{fmt(0)}</span>
									<ActionGutter />
								</div>
							) : (
								<button
									type="button"
									onClick={() => toggle(cat)}
									aria-expanded={open}
									aria-label={c.sectionLabel(cap(cat))}
									className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-5 py-2.5 text-left text-[0.92rem] hover:bg-surface-2"
								>
									<span
										className={`flex-none text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
									>
										<ChevronIcon />
									</span>
									<span className="font-medium">{cap(cat)}</span>
									<span className="ml-auto font-semibold tabular-nums">{fmt(subtotal)}</span>
									<ActionGutter />
								</button>
							)}

							{open && (
								<ul className="m-0 flex list-none flex-col gap-3 border-t border-line px-5 py-4">
									{rows.map((it) => (
										<li key={it.id} className="group flex items-center gap-3">
											<div className="flex min-w-0 flex-col">
												<span className="truncate text-[0.93rem] font-medium" title={it.label}>
													{it.label}
												</span>
												<span className="muted truncate text-[0.8rem]" title={who(it)}>
													{who(it)}
												</span>
											</div>
											{/* The ledger's amount block, unchanged: the figure that answers
											    the question the table is being read with takes the headline,
											    and the one it was derived from goes underneath. The row is
											    two lines tall either way, because the label already carries
											    a second line, so a converted line is no taller than any
											    other. */}
											<span className="ml-auto flex flex-col items-end text-right font-semibold">
												{viewAs ? (
													<>
														{fmt(amount(it))}
														<span className="muted text-[0.75rem] font-medium">
															{c.ofTotal(fmt(it.homeCents))}
														</span>
													</>
												) : (
													<>
														{formatMoney(it.amountCents, it.currency || home, { whole: true })}
														{converted(it) && (
															<span className="muted text-[0.75rem] font-medium">
																≈ {fmt(it.homeCents)}
															</span>
														)}
													</>
												)}
											</span>
											<span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
												<IconButton label={c.editLabel(it.label)} onClick={() => onEdit(it)}>
													<PencilIcon />
												</IconButton>
												<IconButton
													label={c.removeLabel(it.label)}
													danger
													onClick={() => onRemove(it)}
												>
													<TrashIcon />
												</IconButton>
											</span>
										</li>
									))}
								</ul>
							)}
						</section>
					);
				})
			)}

			<div className="flex items-center gap-3 border-t border-line bg-surface-2 px-5 py-2.5 text-[0.92rem] font-medium">
				<span>{viewAs ? shareLabel(members, viewAs, me) : c.total}</span>
				<span className="ml-auto font-semibold tabular-nums">{fmt(total)}</span>
				<ActionGutter />
			</div>
		</div>
	);
}

/**
 * The width a row's hover pencil and bin occupy, held open on the lines that
 * have no actions of their own.
 *
 * Without it every subtotal and the grand total sit that much further right
 * than the amounts they are the sum of, which reads as two columns rather than
 * one.
 */
const ActionGutter = () => (
	<span className="w-[calc(2*var(--control-h-sm)+0.25rem)] flex-none" aria-hidden />
);

const who = (it: CostItem) =>
	it.people.length === 0 ? cv.everyone : it.people.map((p) => p.name).join(', ');
