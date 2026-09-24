import { useState, type ReactNode } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { TrashIcon } from './icons';
import { copy } from '../../copy';

/**
 * The delete button a dialog footer pins to its left, in its `start` slot.
 *
 * It reads "Delete" at desk widths and turns into a square bin at phone widths
 * (`.mdelete` in `index.css`), where the footer has one row and the primary
 * action should have most of it. Both are drawn and the stylesheet picks one, so
 * the button is the same element, with the same focus and the same handler, at
 * every width.
 *
 * The accessible name carries the thing's name at every width, not only when
 * the word is gone: a name that changed with the viewport would make the same
 * button a different control to a screen reader on a phone. The visible word
 * starts that name, so a voice command that says what it sees still lands.
 */
export function DeleteButton({ name, onClick }: { name: string; onClick: () => void }) {
	const label = copy.common.deleteLabel(name);
	return (
		<button
			type="button"
			className="btn danger mdelete"
			aria-label={label}
			title={label}
			onClick={onClick}
		>
			<TrashIcon />
			<span>{copy.common.delete}</span>
		</button>
	);
}

/**
 * The delete that lives in an edit dialog's footer, plus the confirmation it
 * opens.
 *
 * Rows used to carry a pencil and a bin of their own, revealed on hover. That
 * cost every list two control columns it could not spare on a phone, where
 * there is no hover to reveal them with, so they were shown outright and ate
 * the width the row's own words needed. Opening the row is the edit now, and
 * the delete goes where the rest of the editing already is.
 *
 * Two dialogs, never stacked: the caller passes `asking` to its own `Modal` as
 * `open={!asking}`, so the form steps aside while the question is asked and
 * comes back if the answer is no.
 *
 * `onDelete` may be null, for the rows that can be edited but not removed. The
 * hook still runs; only the two nodes come back empty.
 */
export function useDeleteAction({
	title,
	name,
	busyLabel,
	onDelete
}: {
	/** Names the thing being deleted. The confirmation carries no body. */
	title: string;
	/** The thing's own name, for the button's accessible name ("Delete Tram 28"). */
	name: string;
	busyLabel?: string;
	onDelete?: (() => void | Promise<void>) | null;
}): { asking: boolean; button: ReactNode; confirm: ReactNode } {
	const [asking, setAsking] = useState(false);

	if (!onDelete) return { asking: false, button: null, confirm: null };

	return {
		asking,
		button: (
			// Always the one word, on every dialog that has this button. The label
			// used to bend to the case: "Remove" for a person, "Delete and 3 events"
			// for a place on the calendar. Whatever is particular about a delete
			// belongs in the question the confirmation asks, not in the button that
			// opens it, which is the same action every time.
			<DeleteButton name={name} onClick={() => setAsking(true)} />
		),
		confirm: (
			<ConfirmDialog
				open={asking}
				title={title}
				busyLabel={busyLabel}
				onCancel={() => setAsking(false)}
				onConfirm={onDelete}
			/>
		)
	};
}
