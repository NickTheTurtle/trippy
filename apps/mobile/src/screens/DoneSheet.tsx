import { useEffect, useState } from 'react';
import { copy } from '@trippy/copy';
import { InsetSection } from '../ui';
import { ChecklistRow } from '../ui/controls';
import { Sheet } from '../ui/Sheet';

type Person = { id: string; name: string; done: boolean };
type Task = { id: string; label: string; people: Person[] };

/**
 * Who has finished a task: the native form of the web's "13/20 done" menu.
 *
 * Each tick saves as it is made (the same per-person toggle the row used to
 * offer inline), so there is nothing to commit: Cancel and Done both only
 * close. A tick shows at once and holds until the reread agrees with it; a
 * refusal drops every pending tick so the list falls back to what was saved.
 */
export function DoneSheet({
	open,
	task,
	me,
	error,
	onToggle,
	onClose,
	onDismiss
}: {
	open: boolean;
	task: Task | null;
	me: string;
	/** A refused tick, pinned in the sheet: the app's toast renders under a Modal on iOS. */
	error?: string | null;
	onToggle: (personId: string, done: boolean) => void;
	onClose: () => void;
	onDismiss?: () => void;
}) {
	const [pending, setPending] = useState<Record<string, boolean>>({});

	useEffect(() => {
		setPending({});
	}, [task?.id, open]);

	// Drop the ticks the server has caught up with. Pruning, not clearing, so a
	// quick second tick is not undone by the reread that answered the first.
	useEffect(() => {
		if (!task) return;
		setPending((current) => {
			const next: Record<string, boolean> = {};
			for (const person of task.people) {
				const want = current[person.id];
				if (want !== undefined && want !== person.done) next[person.id] = want;
			}
			return next;
		});
	}, [task]);

	useEffect(() => {
		if (error) setPending({});
	}, [error]);

	const people = task?.people ?? [];
	const isDone = (person: Person) => pending[person.id] ?? person.done;
	const doneCount = people.filter(isDone).length;

	return (
		<Sheet
			open={open}
			title={copy.preparation.taskList.doneSheetTitle}
			subtitle={task?.label}
			onClose={onClose}
			onPrimary={onClose}
			primaryLabel={copy.preparation.taskList.doneSheetClose}
			onDismiss={onDismiss}
			error={error}
		>
			<InsetSection footer={copy.preparation.taskList.doneSummary(doneCount, people.length)}>
				{people.map((person, index) => (
					<ChecklistRow
						key={person.id}
						label={person.name + (person.id === me ? copy.preparation.youSuffix : '')}
						checked={isDone(person)}
						last={index === people.length - 1}
						onPress={() => {
							const want = !isDone(person);
							setPending((current) => ({ ...current, [person.id]: want }));
							onToggle(person.id, want);
						}}
					/>
				))}
			</InsetSection>
		</Sheet>
	);
}
