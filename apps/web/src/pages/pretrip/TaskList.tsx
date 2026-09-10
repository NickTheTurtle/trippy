import EmptyState from '../../components/ui/EmptyState';
import MultiSelect from '../../components/ui/MultiSelect';
import { IconButton } from '../../components/ui/buttons';
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
	onEdit,
	onRemove
}: {
	items: Task[];
	kind: 'task' | 'packing';
	me: string;
	/** Tick the shared box of a task that has nobody on it. */
	onToggle: (taskId: string) => void;
	/** Say exactly who has finished a task, in one press. */
	onSetDone: (task: Task, doneIds: string[]) => void;
	onEdit: (task: Task) => void;
	onRemove: (task: Task) => void;
}) {
	if (items.length === 0) {
		// No button here: every section that renders this list already carries its
		// own Add in the header a few pixels above, and two of the same action on
		// one empty screen is the louder of the two ways to say it.
		return <EmptyState graphic message={copy.common.nothingAdded} />;
	}

	return (
		<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
			{items.map((it) => {
				const assigned = it.people.length > 0;
				return (
					<li key={it.id}>
						{/* `group` so the row's buttons can stay hidden until it is hovered
						    without a hover-only stylesheet rule. */}
						<div className="group flex min-w-0 items-center gap-3 rounded-[10px] px-1.5 py-2 text-[0.94rem] hover:bg-surface-2">
							<Box
								state={it.done ? 'on' : it.doneCount > 0 ? 'part' : 'off'}
								label={
									assigned ? c.allBoxLabel(it.done, it.label) : c.sharedBoxLabel(it.done, it.label)
								}
								onClick={() =>
									assigned
										? onSetDone(it, it.done ? [] : it.people.map((p) => p.id))
										: onToggle(it.id)
								}
							/>

							<span
								className={`min-w-0 flex-1 truncate ${it.done ? 'text-ink-faint line-through' : ''}`}
								title={it.label}
							>
								{it.label}
							</span>

							{it.flag && <span className="chip flex-none border-warn text-warn">{it.flag}</span>}

							{assigned && (
								<div className="w-36 flex-none">
									<MultiSelect
										compact
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

							<span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
								<IconButton label={c.editLabel(kind, it.label)} onClick={() => onEdit(it)}>
									✎
								</IconButton>
								<IconButton
									label={c.removeLabel(kind, it.label)}
									danger
									onClick={() => onRemove(it)}
								>
									×
								</IconButton>
							</span>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The leading box. `part` is some but not all of the roster: without it a task
 * two people out of three have finished looks identical to one nobody has
 * started.
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
			className={`grid size-[18px] flex-none cursor-pointer place-items-center rounded-[5px] border p-0 text-[0.72rem] ${
				state === 'on'
					? 'border-accent bg-accent text-white'
					: state === 'part'
						? 'border-accent bg-accent-soft text-accent-ink'
						: 'border-line bg-surface text-white hover:border-accent'
			}`}
		>
			{state === 'on' ? '✓' : state === 'part' ? '–' : ''}
		</button>
	);
}
