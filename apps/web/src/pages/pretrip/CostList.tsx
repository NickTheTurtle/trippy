import { useState } from 'react';
import EmptyState from '../../components/ui/EmptyState';
import ViewAsBar, { shareLabel } from '../../components/ui/ViewAsBar';
import { ChevronIcon } from '../../components/ui/icons';
import type { CostItem } from './types';
import { amountFor, isFor } from './shares';
import { formatMoney, cap } from '../../lib/format';
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
	onEdit
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
	/** Pressing a row opens it; the delete lives in that dialog. */
	onEdit: (it: CostItem) => void;
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
								<div className="flex items-center gap-3 bg-surface-2 px-5 py-2.5 text-body text-ink-faint">
									<span className="size-3.5 flex-none" />
									<span className="font-semibold">{cap(cat)}</span>
									<span className="ml-auto tabular-nums">{fmt(0)}</span>
								</div>
							) : (
								<button
									type="button"
									onClick={() => toggle(cat)}
									aria-expanded={open}
									aria-label={c.sectionLabel(cap(cat))}
									className="flex w-full cursor-pointer items-center gap-3 border-0 bg-surface-2 px-5 py-2.5 text-left text-body font-semibold hover:bg-line"
								>
									<span
										className={`flex-none text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
									>
										<ChevronIcon />
									</span>
									<span>{cap(cat)}</span>
									<span className="ml-auto tabular-nums">{fmt(subtotal)}</span>
								</button>
							)}

							{open && (
								<ul className="m-0 flex list-none flex-col gap-3 border-t border-line px-5 py-4">
									{rows.map((it) => (
										<li key={it.id}>
											{/* The whole row is the control: it holds nothing else that
											    can be pressed, so there is no smaller target to aim for
											    and no icon column to keep clear for one. */}
											<button
												type="button"
												onClick={() => onEdit(it)}
												aria-label={c.editLabel(it.label)}
												className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
											>
												<span className="flex min-w-0 flex-col">
													<span className="truncate text-body font-medium" title={it.label}>
														{it.label}
													</span>
													<span className="muted truncate text-meta" title={who(it)}>
														{who(it)}
													</span>
												</span>
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
															<span className="muted text-micro font-medium">
																{c.ofTotal(fmt(it.homeCents))}
															</span>
														</>
													) : (
														<>
															{formatMoney(it.amountCents, it.currency || home, { whole: true })}
															{converted(it) && (
																<span className="muted text-micro font-medium">
																	≈ {fmt(it.homeCents)}
																</span>
															)}
														</>
													)}
												</span>
											</button>
										</li>
									))}
								</ul>
							)}
						</section>
					);
				})
			)}

			{/* The grand total shares the sections' tint, so it is set apart by
			    weight and height instead: it is the one figure on the card that
			    is not a part of something else. It waits for a first estimate:
			    a bold zero under an empty table states a conclusion the table
			    has not reached. */}
			{items.length > 0 && (
				<div className="flex items-center gap-3 border-t border-line bg-surface-2 px-5 py-3.5 text-lead font-semibold">
					<span>{viewAs ? shareLabel(members, viewAs, me) : c.total}</span>
					<span className="ml-auto text-section font-bold tabular-nums">{fmt(total)}</span>
				</div>
			)}
		</div>
	);
}

const who = (it: CostItem) =>
	it.people.length === 0 ? cv.everyone : it.people.map((p) => p.name).join(', ');
