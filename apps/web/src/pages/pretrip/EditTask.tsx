import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal from '../../components/ui/Modal';
import FormError from '../../components/ui/FormError';
import { LinkButton } from '../../components/ui/buttons';
import type { TaskDraft } from './types';
import { copy } from '../../copy';

const c = copy.preparation.taskDialog;

/**
 * Adds or rewrites one task or one packing item, with who has to do it.
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
					body: { kind: draft.kind, label, assignees: [...assignees] }
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

					<fieldset className="m-0 min-w-0 rounded-[10px] border border-line px-3 py-3">
						<legend className="px-1 text-[0.8rem] text-ink-soft">{c.assigneesLegend}</legend>
						<div className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(min(9rem,100%),1fr))] gap-0.5 overflow-y-auto overscroll-contain">
							{members.map((m) => (
								<label
									key={m.id}
									className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-[0.85rem] text-ink hover:bg-surface-2"
								>
									<input
										type="checkbox"
										checked={assignees.has(m.id)}
										onChange={() =>
											setAssignees((prev) => {
												const next = new Set(prev);
												if (next.has(m.id)) next.delete(m.id);
												else next.add(m.id);
												return next;
											})
										}
										className="flex-none accent-accent"
									/>
									<span className="min-w-0 truncate">
										{m.name}
										{m.id === me ? copy.preparation.youSuffix : ''}
									</span>
								</label>
							))}
							{members.length === 0 && <p className="muted text-[0.9rem]">{c.noMembers}</p>}
						</div>
						{members.length > 2 && (
							<div className="flex gap-3 px-1 pt-2">
								<LinkButton onClick={() => setAssignees(new Set(members.map((m) => m.id)))}>
									{c.selectEveryone}
								</LinkButton>
								<LinkButton onClick={() => setAssignees(new Set())}>{c.clear}</LinkButton>
							</div>
						)}
					</fieldset>
				</div>

				<div className="mfoot">
					<FormError message={save.error} />
					<button className="btn" type="button" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button className="btn primary" type="submit" disabled={save.busy}>
						{save.busy
							? editing
								? copy.common.saving
								: copy.common.adding
							: editing
								? c.saveLabel
								: c.addLabel}
					</button>
				</div>
			</form>
		</Modal>
	);
}
