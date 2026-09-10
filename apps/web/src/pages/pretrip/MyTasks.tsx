import { Box } from './TaskList';
import type { Task } from './types';
import { copy } from '../../copy';

const c = copy.preparation.myTasks;

/**
 * What the trip is waiting on from you, pinned above the full list.
 *
 * The list below is the whole trip's, sorted by what is outstanding across
 * everyone, so your own two jobs can sit anywhere in it. This block answers the
 * only question most people open the tab for.
 *
 * Ticked tasks stay, checked and at the bottom: dropping them out of the block
 * the moment you tick one makes the row you just pressed vanish, and removes
 * the only place you could undo it.
 */
export default function MyTasks({
	items,
	me,
	onToggle
}: {
	items: Task[];
	me: string;
	/** Ticks your own box, not the whole task's. */
	onToggle: (taskId: string) => void;
}) {
	const mine = items
		.map((t) => ({ task: t, done: t.people.find((p) => p.id === me)?.done }))
		.filter((x) => x.done !== undefined)
		.sort((a, b) => Number(a.done) - Number(b.done));

	if (mine.length === 0) return null;

	return (
		<div className="card mb-4 min-w-0 px-5 py-4">
			<h3 className="m-0 mb-2 text-[0.8rem] font-semibold tracking-wide text-ink-soft uppercase">
				{c.title}
			</h3>
			<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
				{mine.map(({ task, done }) => (
					<li key={task.id}>
						<div className="flex min-w-0 items-center gap-3 rounded-[10px] px-1.5 py-1.5 text-[0.94rem] hover:bg-surface-2">
							<Box
								state={done ? 'on' : 'off'}
								label={c.boxLabel(!!done, task.label)}
								onClick={() => onToggle(task.id)}
							/>
							<span
								className={`min-w-0 flex-1 truncate ${done ? 'text-ink-faint line-through' : ''}`}
								title={task.label}
							>
								{task.label}
							</span>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
