import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import { LinkButton } from '../../components/ui/buttons';
import MultiSelect from '../../components/ui/MultiSelect';
import type { TaskDraft } from './types';
import { copy } from '../../copy';

const c = copy.preparation.taskDialog;

/**
 * Adds or rewrites one task or one packing item.
 *
 * Only a task carries a roster. A packing item is your own bag, so asking who
 * it is for is a question with one answer, and the server drops any roster sent
 * with one whatever the client does.
 *
 * Add and edit are the same form, the way they are for a cost estimate: the
 * fields are identical, and a second component for them would be the first one
 * with a different verb.
 *
 * Editing keeps the ticks of everyone who is still on the task. Rewriting a
 * task used to mean deleting it and adding it again, which threw away what
 * other people had already done.
 */
export default function EditTask({
	draft,
	members,
	me,
	tripId,
	onClose,
	onSaved
}: {
	draft: TaskDraft;
	members: { id: string; name: string }[];
	me: string;
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState(draft.label);
	const [assignees, setAssignees] = useState<Set<string>>(new Set(draft.assignees));
	const editing = draft.id !== null;

	const save = useMutation(
		async () => {
			await api(
				editing ? `/trips/${tripId}/pretrip/tasks/${draft.id}` : `/trips/${tripId}/pretrip/tasks`,
				{
					method: editing ? 'PUT' : 'POST',
					body: {
						kind: draft.kind,
						label,
						assignees: [...assignees],
						// The version this dialog opened on, so a save that would
						// silently overwrite somebody else's is refused instead.
						version: draft.version ?? undefined
					}
				}
			);
			onSaved();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<Modal open size="sm" title={c.title(draft.kind, editing)} onClose={onClose}>
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-3">
					<label className="field">
						<span>{c.labelField}</span>
						<input
							autoFocus
							required
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							className="input w-full"
						/>
					</label>

					{draft.kind === 'task' && (
						<div className="flex flex-col gap-2">
							<MultiSelect
								options={members.map((m) => ({
									value: m.id,
									label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
								}))}
								selected={[...assignees]}
								onChange={(next) => setAssignees(new Set(next))}
								ariaLabel={c.assignPlaceholder}
								placeholder={members.length === 0 ? c.noMembers : c.assignPlaceholder}
							/>
							{members.length > 2 && (
								<div className="flex gap-3 px-1">
									<LinkButton onClick={() => setAssignees(new Set(members.map((m) => m.id)))}>
										{c.selectEveryone}
									</LinkButton>
									<LinkButton onClick={() => setAssignees(new Set())}>{c.clear}</LinkButton>
								</div>
							)}
						</div>
					)}
				</div>

				<ModalFooter
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={editing ? copy.common.saving : copy.common.adding}
					submitLabel={editing ? copy.common.save : c.addLabel}
				/>
			</form>
		</Modal>
	);
}
