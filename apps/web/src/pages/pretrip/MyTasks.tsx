import { type ComponentProps } from 'react';
import TaskList, { ListTitle } from './TaskList';
import type { Task } from './types';
import { copy } from '../../copy';

const c = copy.preparation.myTasks;

export const isMine = (task: Task, me: string) => task.people.some((p) => p.id === me);

/**
 * What the trip is waiting on from you, lifted out of the list below.
 *
 * The rows move rather than being copied: the same task in two places is two
 * boxes to reason about, and ticking one while its twin sits unticked a few
 * pixels down reads as a bug. So this block holds the whole row, roster menu
 * and edit and bin included, and the list below is everything else.
 *
 * Ticked tasks stay, checked and at the bottom: dropping them the moment you
 * tick one makes the row you just pressed vanish, and removes the only place
 * you could undo it.
 */
export default function MyTasks(props: Omit<ComponentProps<typeof TaskList>, 'kind' | 'boxFor'>) {
	const doneByMe = (t: Task) => Number(t.people.find((p) => p.id === props.me)?.done);
	const mine = props.items
		.filter((t) => isMine(t, props.me))
		.sort((a, b) => doneByMe(a) - doneByMe(b));

	if (mine.length === 0) return null;

	return (
		<div className="card mb-4 min-w-0 px-5 py-5">
			<ListTitle>{c.title}</ListTitle>
			<TaskList {...props} items={mine} kind="task" boxFor={props.me} />
		</div>
	);
}
