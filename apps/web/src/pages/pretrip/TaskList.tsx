import EmptyState from '../../components/ui/EmptyState';
import FlipGrid from '../../components/ui/FlipGrid';
import MultiSelect from '../../components/ui/MultiSelect';
import { CheckIcon, MinusIcon } from '../../components/ui/icons';
import type { Task } from './types';
import { copy } from '../../copy';

const c = copy.preparation.taskList;

/**
 * The tasks and the packing list are the same rows with different words, so
 * they are one component switched by `kind`.
 *
 * One row is one line: a box, the label, then who has finished it.
 *
 * Who has finished is a menu rather than a chip per person. The chips said
 * everything at a glance, but only on a small trip: a dozen people on one task
 * wrapped the row over three lines and pushed the label out of the way. The
 * menu holds one width whatever the size of the group, and the trigger carries
 * the count, which is the part that gets read.
 *
 * Anyone may tick anyone. A trip gets planned out loud, and the person holding
 * the phone is not always the person whose box it is.
 */
export default function TaskList({
	items,
	kind,
	me,
	onToggle,
	onSetDone,
	onEdit
}: {
	items: Task[];
	kind: 'task' | 'packing';
	me: string;
	/** Tick the shared box of a task that has nobody on it. */
	onToggle: (taskId: string, done: boolean) => void;
	/** Say exactly who has finished a task, in one press. */
	onSetDone: (task: Task, doneIds: string[]) => void;
	/** Pressing the row's label opens it; the delete lives in that dialog. */
	onEdit: (task: Task) => void;
}) {
	if (items.length === 0) {
		// No button here: every section that renders this list already carries its
		// own Add in the header a few pixels above, and two of the same action on
		// one empty screen is the louder of the two ways to say it.
		return <EmptyState graphic message={copy.common.nothingAdded} />;
	}

	return (
		<FlipGrid
			as="ul"
			// Ticking a row sends it to the bottom of the list, so what moved is
			// what is done. The label is in the signature too: a rename can change a
			// row's height, which moves everything under it.
			signature={items.map((it) => `${it.id}:${it.done}:${it.label}`).join(',')}
			className="m-0 flex list-none flex-col gap-0.5 p-0"
		>
			{items.map((it) => {
				const assigned = it.people.length > 0;
				return (
					<li key={it.id} data-flip={it.id}>
						{/* `group` so the leading box can take its cue from the whole row
						    being hovered, not just from the 18px box itself. Wraps rather
						    than shrinks: on a narrow screen the label was squeezed to two
						    letters and an ellipsis while the controls kept their width. */}
						<div className="group flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1.5 py-2 text-body hover:bg-surface-2">
							<Box
								state={it.done ? 'on' : it.doneCount > 0 ? 'part' : 'off'}
								label={
									assigned ? c.allBoxLabel(it.done, it.label) : c.sharedBoxLabel(it.done, it.label)
								}
								onClick={() =>
									assigned
										? onSetDone(it, it.done ? [] : it.people.map((p) => p.id))
										: onToggle(it.id, !it.done)
								}
							/>

							<button
								type="button"
								onClick={() => onEdit(it)}
								aria-label={c.editLabel(kind, it.label)}
								title={it.label}
								className={`tap-grow min-w-0 flex-1 basis-48 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-body ${it.done ? 'text-ink-faint line-through' : ''}`}
							>
								{it.label}
							</button>

							{it.flag && <span className="chip flex-none border-warn text-warn">{it.flag}</span>}

							{assigned && (
								<div className="w-32 flex-none">
									<MultiSelect
										compact
										quiet
										options={it.people.map((p) => ({
											value: p.id,
											label: p.name + (p.id === me ? copy.preparation.youSuffix : '')
										}))}
										selected={it.people.filter((p) => p.done).map((p) => p.id)}
										summary={c.doneSummary(it.doneCount, it.people.length)}
										ariaLabel={c.doneMenuLabel(it.label)}
										onChange={(next) => onSetDone(it, next)}
									/>
								</div>
							)}
						</div>
					</li>
				);
			})}
		</FlipGrid>
	);
}

/**
 * The heading a list carries only when the tab is split in two, so a single
 * undivided list is never labelled with what it obviously is.
 */
export function ListTitle({ children }: { children: string }) {
	return (
		<h2 className="m-0 mb-2 text-meta font-semibold tracking-wider text-ink-soft uppercase">
			{children}
		</h2>
	);
}

/**
 * The leading box. `part` is some but not all of the roster: without it a task
 * two people out of three have finished looks identical to one nobody has
 * started.
 *
 * An empty box holds a transparent tick that comes up faint as soon as the row
 * is hovered, not only once the pointer is over the 18px box itself, so the
 * control shows what pressing it will do while you are still on your way to it.
 */
function Box({
	state,
	label,
	onClick
}: {
	state: 'on' | 'part' | 'off';
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={state === 'on'}
			aria-label={label}
			title={label}
			className={`tap grid size-[18px] flex-none cursor-pointer place-items-center rounded-[5px] border p-0 transition-colors ${
				state === 'on'
					? 'border-accent bg-accent text-white'
					: state === 'part'
						? 'border-accent bg-accent-soft text-accent-ink'
						: 'border-line bg-surface text-transparent group-hover:border-ink-faint group-hover:text-ink-faint hover:border-accent! hover:text-accent!'
			}`}
		>
			{state === 'part' ? <MinusIcon /> : <CheckIcon />}
		</button>
	);
}
