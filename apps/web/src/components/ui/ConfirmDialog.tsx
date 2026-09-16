import { useState } from 'react';
import Modal from './Modal';
import { DialogError } from './Toast';
import { copy } from '../../copy';

/**
 * The shared confirmation dialog.
 *
 * Confirmation was inconsistent across the app: one page had its own delete
 * dialog, another asked by making you click the same button twice, and three
 * more deleted on the first click with no way back. This is the one answer, so
 * a destructive action asks the same way wherever it lives.
 *
 * It asks one question and takes no body. Each dialog used to explain what its
 * delete would destroy, in counts, and between them those explanations ran to
 * more words than the rest of the page. The thing being deleted is named in the
 * title, which is what the reader needs to answer the question; the rest was
 * detail nobody asked for at the moment they were trying to leave.
 *
 * `onConfirm` may be async: the dialog holds itself open and disables its own
 * buttons while it runs, and announces the failure in the corner rather than
 * closing over the top of it, because a dialog that vanishes on a failed delete
 * leaves the user guessing whether the thing is gone.
 */
export default function ConfirmDialog({
	open,
	title,
	confirmLabel = copy.common.delete,
	cancelLabel = copy.common.cancel,
	busyLabel,
	size = 'sm',
	onCancel,
	onConfirm
}: {
	open: boolean;
	title: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Shown on the confirm button while `onConfirm` is running. */
	busyLabel?: string;
	size?: 'sm' | 'md' | 'lg';
	onCancel: () => void;
	onConfirm: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	async function confirm() {
		setBusy(true);
		setError('');
		try {
			await onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : copy.ui.confirmDialog.fallback);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			open={open}
			title={title}
			size={size}
			onClose={() => {
				// Escape and the backdrop must not cancel a confirm that is already
				// on its way to the server.
				if (!busy) onCancel();
			}}
		>
			<div className="mbody">
				<p className="m-0">{copy.ui.confirmDialog.undone}</p>
			</div>
			<div className="mfoot">
				<DialogError message={error} />
				<button className="btn" type="button" disabled={busy} onClick={onCancel}>
					{cancelLabel}
				</button>
				<button className="btn danger solid" type="button" disabled={busy} onClick={confirm}>
					{busy ? (busyLabel ?? copy.common.working) : confirmLabel}
				</button>
			</div>
		</Modal>
	);
}
