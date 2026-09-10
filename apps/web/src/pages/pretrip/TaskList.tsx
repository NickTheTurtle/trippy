import { useState } from 'react';
import EmptyState from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/buttons';
import type { Task } from './types';
import { copy } from '../../copy';

const c = copy.preparation.taskList;

/**
 * The tasks and the packing list are the same rows with different words, so
 * they are one component switched by `kind`.
 */
export default function TaskList({
	items,
	kind,
	me,
	empty,
	onToggle,
	onRemove,
	onAdd
}: {
	items: Task[];
	kind: 'task' | 'packing';
	me: string;
	empty: string;
	onToggle: (taskId: string, userId?: string) => void;
	onRemove: (task: Task) => void;
	onAdd: () => void;
}) {
	/** Which task's roster is expanded. Only one at a time, because these lists are long. */
	const [openRoster, setOpenRoster] = useState<string | null>(null);

	if (items.length === 0) {
		return (
			<EmptyState
				className="py-2"
				message={empty}
				action={
					<button type="button" className="btn small" onClick={onAdd}>
						{kind === 'task' ? c.taskAction : c.packingAction}
					</button>
				}
			/>
		);
	}

	return (
		<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
			{items.map((it) => {
				const mine = it.people.find((p) => p.id === me) ?? null;
				return (
					<li key={it.id}>
						{/* `group` so the delete button can stay hidden until the row is
						    hovered without a hover-only stylesheet rule. */}
						<div className="group flex min-w-0 items-center gap-2.5 rounded-[10px] px-1.5 py-2 text-[0.94rem] hover:bg-surface-2">
							{it.people.length === 0 ? (
								<Box
									on={it.shared}
									label={c.sharedBoxLabel(it.shared, it.label)}
									onClick={() => onToggle(it.id)}
								/>
							) : mine ? (
								<Box
									on={mine.done}
									label={c.yourBoxLabel(mine.done, it.label)}
									onClick={() => onToggle(it.id)}
								/>
							) : (
								/* Not yours to tick, so it is not a control. It still has to show
								   whether the task got done, or the row reads as struck through
								   and unchecked at the same time. */
								<span
									title={c.othersTitle(it.done)}
									aria-label={c.othersLabel(it.label, it.done)}
									className={`grid size-[18px] flex-none place-items-center rounded-[5px] border border-dashed text-[0.72rem] ${
										it.done
											? 'border-accent bg-accent-soft text-accent-ink'
											: 'border-line bg-surface-2'
									}`}
								>
									{it.done ? '✓' : ''}
								</span>
							)}

							<span
								className={`min-w-0 flex-1 truncate ${it.done ? 'text-ink-faint line-through' : ''}`}
								title={it.label}
							>
								{it.label}
							</span>

							{it.flag && <span className="chip flex-none border-warn text-warn">{it.flag}</span>}

							{it.people.length > 0 && (
								<div className="flex min-w-0 flex-none items-center gap-1.5">
									{it.people.length === 1 ? (
										<span
											className="max-w-36 truncate text-[0.74rem] text-ink-soft"
											title={it.people[0].name}
										>
											{it.people[0].name}
										</span>
									) : (
										/* The bar carries the at-a-glance signal, the count is the
										   accessible text, and the whole thing expands the roster. */
										<button
											type="button"
											aria-expanded={openRoster === it.id}
											title={c.rosterTitle}
											onClick={() => setOpenRoster((v) => (v === it.id ? null : it.id))}
											className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pr-2 pl-1.5 text-[0.74rem] text-ink-soft hover:border-accent"
										>
											<span className="block h-1 w-[34px] flex-none overflow-hidden rounded-full bg-line">
												<span
													className="block h-full bg-accent"
													style={{
														width: `${(it.doneCount / it.people.length) * 100}%`
													}}
												/>
											</span>
											<span className="tabular-nums whitespace-nowrap">
												{it.doneCount}/{it.people.length}
											</span>
										</button>
									)}
									{mine && (
										<span
											className={`flex-none rounded-full px-2 py-0.5 text-[0.72rem] whitespace-nowrap ${
												mine.done ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-ink-faint'
											}`}
										>
											{mine.done ? c.youDone : c.youToDo}
										</span>
									)}
								</div>
							)}

							<IconButton
								label={c.removeLabel(kind, it.label)}
								danger
								className="flex-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
								onClick={() => onRemove(it)}
							>
								×
							</IconButton>
						</div>

						{openRoster === it.id && (
							<ul className="flex list-none flex-row flex-wrap gap-1.5 pt-0.5 pr-1.5 pb-2.5 pl-8">
								{it.people.map((p) => {
									const isMe = p.id === me;
									const cls = [
										'inline-flex max-w-44 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.76rem]',
										p.done
											? 'border-transparent bg-accent-soft text-accent-ink'
											: 'border-line bg-surface text-ink-soft',
										isMe ? 'cursor-pointer' : 'cursor-default'
									].join(' ');
									const inner = (
										<>
											<span
												className={`grid size-3 flex-none place-items-center rounded-[4px] border border-current text-[0.6rem] ${p.done ? '' : 'opacity-70'}`}
											>
												{p.done ? '✓' : ''}
											</span>
											<span className="min-w-0 truncate" title={p.name}>
												{p.name}
												{isMe ? copy.preparation.youSuffix : ''}
											</span>
										</>
									);
									return (
										<li key={p.id} className="min-w-0">
											{isMe ? (
												<button
													type="button"
													className={cls}
													onClick={() => onToggle(it.id)}
													aria-label={c.rosterToggleLabel(p.done, it.label)}
												>
													{inner}
												</button>
											) : (
												<span className={cls}>{inner}</span>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function Box({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			className={`grid size-[18px] flex-none cursor-pointer place-items-center rounded-[5px] border p-0 text-[0.72rem] text-white ${
				on ? 'border-accent bg-accent' : 'border-line bg-surface'
			}`}
		>
			{on ? '✓' : ''}
		</button>
	);
}
