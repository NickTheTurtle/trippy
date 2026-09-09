import { useState, type ReactNode } from 'react';
import Modal from './Modal';
import FormError from './FormError';

/**
 * The shared confirmation dialog.
 *
 * Confirmation was inconsistent across the app: one page had its own delete
 * dialog, another asked by making you click the same button twice, and three
 * more deleted on the first click with no way back. This is the one answer, so
 * a destructive action asks the same way wherever it lives.
 *
 * `onConfirm` may be async: the dialog holds itself open and disables its own
 * buttons while it runs, and shows the failure in the footer rather than
 * closing over the top of it, because a dialog that vanishes on a failed delete
 * leaves the user guessing whether the thing is gone.
 */
export default function ConfirmDialog({
	open,
	title,
	body,
	confirmLabel = 'Delete',
	cancelLabel = 'Cancel',
	busyLabel,
	destructive = true,
	size = 'sm',
	onCancel,
	onConfirm
}: {
	open: boolean;
	title: string;
	/** What is about to happen, and anything that goes with it. */
	body?: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Shown on the confirm button while `onConfirm` is running. */
	busyLabel?: string;
	/** False for a confirmation that is not a deletion, which drops the red. */
	destructive?: boolean;
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
			setError(err instanceof Error ? err.message : 'Could not do that.');
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
				{body}
				{destructive && <p className="muted m-0 mt-2 text-[0.9rem]">This cannot be undone.</p>}
			</div>
			<div className="mfoot">
				<FormError message={error} />
				<button className="btn" type="button" disabled={busy} onClick={onCancel}>
					{cancelLabel}
				</button>
				<button
					className={destructive ? 'btn danger solid' : 'btn primary'}
					type="button"
					disabled={busy}
					onClick={confirm}
				>
					{busy ? (busyLabel ?? 'Working...') : confirmLabel}
				</button>
			</div>
		</Modal>
	);
}
