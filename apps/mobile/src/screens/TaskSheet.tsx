import { useEffect, useMemo, useState } from 'react';
import { copy } from '@trippy/copy';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { DestructiveRow, Field, InsetSection, ListRow } from '../ui';
import { ChecklistRow } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { ConfirmSheet, confirmOverlays } from '../ui/ConfirmSheet';

type Member = { id: string; name: string };
type Crew = { id: string; name: string; members: string[]; locked?: boolean };
type Task = { id: string; label: string; version: number; people: { id: string; name: string }[] };

export function TaskSheet({
	open,
	tripId,
	kind,
	members,
	crews,
	task,
	onClose,
	onSaved,
	onConflict
}: {
	open: boolean;
	tripId: string;
	kind: 'task' | 'packing';
	members: Member[];
	crews: Crew[];
	task: Task | null;
	onClose: () => void;
	onSaved: () => void;
	onConflict: () => void;
}) {
	const [label, setLabel] = useState('');
	const [assignees, setAssignees] = useState<string[]>([]);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		if (!open) return;
		setLabel(task?.label ?? '');
		setAssignees(task ? task.people.map((p) => p.id) : []);
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, task?.id]);

	const save = useMutation(
		async () => {
			const body = {
				label,
				kind,
				assignees: kind === 'packing' ? [] : assignees,
				version: task?.version
			};
			try {
				if (task) await api(`/trips/${tripId}/pretrip/tasks/${task.id}`, { method: 'PUT', body });
				else await api(`/trips/${tripId}/pretrip/tasks`, { method: 'POST', body });
			} catch (err) {
				if (err instanceof ApiError && err.status === 409) onConflict();
				throw err;
			}
		},
		{ fallback: copy.preparation.taskDialog.fallback, onSuccess: onSaved }
	);

	const remove = useMutation(
		async () => {
			if (!task) return;
			await api(`/trips/${tripId}/pretrip/tasks/${task.id}`, { method: 'DELETE' });
		},
		{
			fallback: copy.preparation.saveFallback,
			onSuccess: () => {
				setConfirmDelete(false);
				onSaved();
			}
		}
	);

	return (
		<>
			<Sheet
				open={open && (confirmOverlays || !confirmDelete)}
				busy={confirmOverlays && remove.busy}
				busyLabel={copy.common.deleting}
				title={copy.preparation.taskDialog.title(kind, !!task)}
				onClose={onClose}
				onPrimary={() => void save.run()}
				primaryLabel={task ? copy.common.save : copy.common.add}
				primaryBusyLabel={task ? copy.common.saving : copy.common.adding}
				primaryBusy={save.busy}
				primaryDisabled={!label.trim()}
			>
				<InsetSection error={save.error}>
					<Field
						variant="row"
						label={copy.preparation.taskDialog.labelField}
						value={label}
						onChangeText={setLabel}
						last
					/>
				</InsetSection>
				{kind === 'task' ? (
					<AssigneePicker
						members={members}
						crews={crews}
						selected={assignees}
						onChange={setAssignees}
					/>
				) : null}
				{task ? (
					<InsetSection>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(task.label)}
							onPress={() => setConfirmDelete(true)}
						/>
					</InsetSection>
				) : null}
			</Sheet>
			<ConfirmSheet
				open={!!task && confirmDelete}
				title={task ? copy.common.deleteTitle(task.label) : ''}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}

function AssigneePicker({
	members,
	crews,
	selected,
	onChange
}: {
	members: Member[];
	crews: Crew[];
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const setAll = (ids: string[]) => onChange([...new Set(ids)]);
	const toggle = (id: string) => {
		const next = new Set(selectedSet);
		if (!next.delete(id)) next.add(id);
		onChange([...next]);
	};
	return (
		<InsetSection
			title={`${copy.preparation.taskDialog.assignLabel}${copy.ui.field.optionalSuffix}`}
		>
			{members.length > 2 ? (
				<>
					<ListRow
						title={copy.preparation.taskDialog.selectEveryone}
						accessory="none"
						onPress={() => setAll(members.map((m) => m.id))}
					/>
					<ListRow
						title={copy.preparation.taskDialog.clear}
						accessory="none"
						onPress={() => onChange([])}
					/>
				</>
			) : null}
			{crews.map((crew) => (
				<ListRow
					key={crew.id}
					title={crew.name}
					subtitle={copy.people.crews.memberCount(crew.members.length)}
					accessory="none"
					onPress={() => setAll(crew.members)}
				/>
			))}
			{members.map((member, index) => {
				const on = selectedSet.has(member.id);
				return (
					<ChecklistRow
						key={member.id}
						label={member.name}
						checked={on}
						onPress={() => toggle(member.id)}
						last={index === members.length - 1}
					/>
				);
			})}
		</InsetSection>
	);
}
