import { useState } from 'react';
import EmptyState from '../../components/ui/EmptyState';
import Select from '../../components/ui/Select';
import { IconButton } from '../../components/ui/buttons';
import { ChevronIcon, PencilIcon, TrashIcon } from '../../components/ui/icons';
import type { CostItem } from './types';
import { amountFor, isFor } from './shares';
import { cap } from './labels';
import { copy } from '../../copy';

const c = copy.preparation.costTable;

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
	const amount = (it: CostItem) => amountFor(it, viewAs, memberCount);

	return (
		<div className="card overflow-hidden p-0">
			<div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
				<span className="muted text-[0.8rem]">{c.viewAs}</span>
				<div className="w-44">
					<Select
						compact
						options={[
							{ value: '', label: c.everyone },
							...members.map((m) => ({
								value: m.id,
								label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
							}))
						]}
						value={viewAs}
						onChange={onViewAs}
						ariaLabel={c.viewAs}
					/>
				</div>
			</div>

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
								<div className="flex items-center gap-2 px-4 py-2.5 text-[0.92rem] text-ink-faint">
									<span className="size-3.5 flex-none" />
									<span>{cap(cat)}</span>
									<span className="ml-auto tabular-nums">{fmt(0)}</span>
								</div>
							) : (
								<button
									type="button"
									onClick={() => toggle(cat)}
									aria-expanded={open}
									aria-label={c.sectionLabel(cap(cat))}
									className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-4 py-2.5 text-left text-[0.92rem] hover:bg-surface-2"
								>
									<span
										className={`flex-none text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
									>
										<ChevronIcon />
									</span>
									<span className="font-medium">{cap(cat)}</span>
									<span className="ml-auto font-semibold tabular-nums">{fmt(subtotal)}</span>
								</button>
							)}

							{open && (
								<ul className="m-0 list-none p-0">
									{rows.map((it) => (
										<li
											key={it.id}
											className="group flex min-w-0 items-center gap-3 border-t border-line px-4 py-2 pl-10 hover:bg-surface-2"
										>
											<span className="min-w-0 flex-1 truncate text-[0.92rem]" title={it.label}>
												{it.label}
											</span>
											<span
												className="muted max-w-[34%] flex-none truncate text-[0.8rem]"
												title={who(it)}
											>
												{who(it)}
											</span>
											<span className="w-24 flex-none text-right font-semibold tabular-nums">
												{fmt(amount(it))}
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

			<div className="flex items-center justify-between gap-4 border-t border-line bg-surface-2 px-4 py-2.5 text-[0.92rem] font-medium">
				<span>{viewAs ? c.share(nameOf(members, viewAs)) : c.total}</span>
				<span className="font-semibold tabular-nums">{fmt(total)}</span>
			</div>
		</div>
	);
}

const who = (it: CostItem) =>
	it.people.length === 0 ? c.everyone : it.people.map((p) => p.name).join(', ');

export const nameOf = (members: { id: string; name: string }[], id: string) =>
	members.find((m) => m.id === id)?.name ?? '';
