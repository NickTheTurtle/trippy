import EmptyState from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/buttons';
import type { Task, Person } from './types';
import { copy } from '../../copy';

const c = copy.preparation.taskList;

/**
 * The tasks and the packing list are the same rows with different words, so
 * they are one component switched by `kind`.
 *
 * One row is one line: a box, the label, then a chip per person it is for.
 *
 * The row used to carry four separate things on its right: a name, or a
 * progress bar that expanded a roster, plus a "You: to do" pill, plus a
 * different leading box depending on whether the task was yours. Five rows of
 * that is five different layouts, and the answer to "who still has to do this"
 * was behind a click. The chips are now always shown and are the control: the
 * roster and the pill said what a row of chips says on its own.
 *
 * Every chip is pressable by anyone. A trip gets planned out loud, and the
 * person holding the phone is not always the person whose box it is.
 */
export default function TaskList({
	items,
	kind,
	me,
	onToggle,
	onToggleAll,
	onRemove
}: {
	items: Task[];
	kind: 'task' | 'packing';
	me: string;
	/** Tick one person's box, or the shared box when the task has nobody on it. */
	onToggle: (taskId: string, userId?: string) => void;
	/** Bring every assignee to the same state in one press of the leading box. */
	onToggleAll: (task: Task) => void;
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
						{/* `group` so the delete button can stay hidden until the row is
						    hovered without a hover-only stylesheet rule. */}
						<div className="group flex min-w-0 items-center gap-3 rounded-[10px] px-1.5 py-2 text-[0.94rem] hover:bg-surface-2">
							<Box
								state={it.done ? 'on' : it.doneCount > 0 ? 'part' : 'off'}
								label={
									assigned ? c.allBoxLabel(it.done, it.label) : c.sharedBoxLabel(it.done, it.label)
								}
								onClick={() => (assigned ? onToggleAll(it) : onToggle(it.id))}
							/>

							<span
								className={`min-w-0 flex-1 truncate ${it.done ? 'text-ink-faint line-through' : ''}`}
								title={it.label}
							>
								{it.label}
							</span>

							{it.flag && <span className="chip flex-none border-warn text-warn">{it.flag}</span>}

							{assigned && (
								<div className="flex min-w-0 flex-wrap justify-end gap-1">
									{it.people.map((p) => (
										<Chip
											key={p.id}
											person={p}
											isMe={p.id === me}
											onClick={() => onToggle(it.id, p.id)}
											label={c.personBoxLabel(p.done, p.name, it.label)}
										/>
									))}
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
					</li>
				);
			})}
		</ul>
	);
}

/** One person's share of a task, and the control that ticks it. */
function Chip({
	person,
	isMe,
	label,
	onClick
}: {
	person: Person;
	isMe: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={person.done}
			aria-label={label}
			title={label}
			className={`inline-flex max-w-44 cursor-pointer items-center gap-1 rounded-full border py-0.5 pr-2.5 text-[0.76rem] ${
				person.done
					? 'border-transparent bg-accent-soft pl-1.5 text-accent-ink'
					: 'border-line bg-surface pl-2.5 text-ink-soft hover:border-accent'
			}`}
		>
			{person.done && <span aria-hidden="true">✓</span>}
			<span className="min-w-0 truncate">
				{person.name}
				{isMe ? copy.preparation.youSuffix : ''}
			</span>
		</button>
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
