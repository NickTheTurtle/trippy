import { copy } from '../../copy';
import type { Crew } from './types';

const c = copy.people.crews;

/**
 * The crews panel: every saved group, and who is in it.
 *
 * Crews used to live behind a button on the schedule toolbar, where the only
 * way to see one was to open a dialog and page through a dropdown. They are a
 * fact about the roster rather than about a day, so they live here, as their
 * own section beside Members.
 *
 * Laid out as the roster is, in the same auto-filled columns: a crew is a
 * handful of names, so a full-width row per crew would be a line of text and a
 * great deal of nothing.
 *
 * Any member may keep them, as the server allows: a crew is a shortcut, and
 * getting one wrong costs nothing the schedule can feel.
 *
 * Everyone is always here and is never editable, so the list is never empty and
 * has no empty state. It is rendered as plain text rather than a dead button:
 * a row that looks like the others but does nothing when clicked is worse than
 * one that plainly is not a control.
 */
export default function CrewList({
	crews,
	names,
	onEdit
}: {
	crews: Crew[];
	/** Member id to display name, for the line of who is in a crew. */
	names: Record<string, string>;
	onEdit: (crew: Crew) => void;
}) {
	return (
		<section className="card px-5 py-5">
			<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-6 gap-y-2 p-0">
				{crews.map((crew) => {
					const who =
						crew.members.length === 0
							? c.nobody
							: crew.members.map((id) => names[id] ?? '').join(', ');
					const body = (
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate font-medium" title={crew.name}>
								{crew.name}
							</span>
							{/* The names, not the count: on a page that is a list of
							    people, "3" answers a question nobody asked. */}
							<span className="muted truncate text-meta" title={who}>
								{who}
							</span>
						</span>
					);
					return (
						<li key={crew.id}>
							{crew.locked ? (
								<span className="flex w-full items-start gap-3 p-2 text-body">{body}</span>
							) : (
								<button
									type="button"
									onClick={() => onEdit(crew)}
									aria-label={copy.common.editLabel(crew.name)}
									className="flex w-full cursor-pointer items-start gap-3 rounded-sm border-0 bg-transparent p-2 text-left text-body hover:bg-surface-2"
								>
									{body}
								</button>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
