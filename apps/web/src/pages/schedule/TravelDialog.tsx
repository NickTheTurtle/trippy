import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import { MODE_OPTIONS, hhmm, modeLabel } from './shared';
import type { LegRow } from './types';

/**
 * One journey: what it is called, who is on it, where it runs between, and what
 * it costs.
 *
 * A leg is derived, never authored: the server plans one for every pair of
 * consecutive events a given set of people attends. So there is nothing to
 * create or delete here, only what the model lets a person say about it: the
 * name it goes by, and a pinned mode and duration. Sending the mode and the
 * minutes empty is the reset, which is why the automatic estimate is an action
 * rather than a value in the picker. The name is not part of that reset: what
 * you call the ferry is not an estimate of how long the ferry takes.
 */
export default function TravelDialog({
	base,
	leg,
	fromTitle,
	toTitle,
	whoLabel,
	onClose,
	onDone
}: {
	base: string;
	leg: LegRow;
	fromTitle: string;
	toTitle: string;
	whoLabel: string;
	onClose: () => void;
	onDone: () => void;
}) {
	const [title, setTitle] = useState(leg.title ?? '');
	const [mode, setMode] = useState(leg.mode ?? leg.resolvedMode);
	const [mins, setMins] = useState(String(leg.mins ?? leg.resolvedMins));

	const patch = (body: { mode: string; mins: string; title?: string }) =>
		api(`${base}/legs/${leg.id}`, { method: 'PATCH', body });

	const save = useMutation(
		async () => {
			await patch({ mode, mins, title: title.trim() });
			onDone();
		},
		{ fallback: 'Could not save that journey.' }
	);

	const auto = useMutation(
		async () => {
			await patch({ mode: '', mins: '' });
			onDone();
		},
		{ fallback: 'Could not reset that journey.' }
	);

	return (
		<Modal
			open
			size="md"
			title="Journey"
			subtitle={`${hhmm(leg.startMin)} to ${hhmm(leg.endMin)}`}
			onClose={onClose}
		>
			<ModalForm className="schedule" onSubmit={save.submit}>
				<div className="mbody">
					<div className="dfacts">
						<span className="dfact">
							{fromTitle} to {toTitle}
						</span>
						<span className="dfact muted">{whoLabel}</span>
						{leg.manual && <span className="tag manual">pinned</span>}
						{leg.tight && <span className="tag warn">does not fit the gap</span>}
					</div>

					<div className="srow">
						<Field
							label="Name"
							optional
							className="grow"
							autoFocus
							placeholder={`${modeLabel(leg.resolvedMode)} to ${toTitle}`}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</div>

					<div className="srow">
						<FieldShell label="Mode" className="tf2">
							<Select value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Mode" />
						</FieldShell>
						<Field
							label="Minutes"
							className="tf2"
							type="number"
							min={1}
							value={mins}
							onChange={(e) => setMins(e.target.value)}
						/>
					</div>
					<p className="m-0 text-meta muted">
						{leg.autoMins == null ? (
							'No automatic estimate for this journey yet.'
						) : leg.manual ? (
							<>
								{`Router: ${modeLabel(leg.autoMode)}, ${leg.autoMins}m. `}
								<button
									type="button"
									className="link"
									disabled={auto.busy}
									onClick={() => void auto.run()}
								>
									Use it instead
								</button>
							</>
						) : (
							`Using the automatic estimate: ${modeLabel(leg.autoMode)}, ${leg.autoMins}m.`
						)}
					</p>
				</div>

				<ModalFooter
					error={save.error || auto.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={copy.common.saving}
					submitLabel={copy.common.save}
				/>
			</ModalForm>
		</Modal>
	);
}
