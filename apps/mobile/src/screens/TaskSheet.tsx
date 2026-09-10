import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { api } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { MemberPicker } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { space, type } from '../theme';

type Member = { id: string; name: string };
type Task = { id: string; label: string; version: number; people: { id: string; name: string }[] };

/**
 * Adding or editing a task or a packing item.
 *
 * One sheet for both, as the web dialog is one dialog for both: the fields are
 * the same and the only difference is which endpoint it posts to and what the
 * title calls the thing.
 *
 * Packing carries no assignment. It was removed there for being more machinery
 * than a shared list of things to bring needs, and it stays absent here.
 */
export function TaskSheet({
	open,
	tripId,
	kind,
	members,
	task,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	kind: 'task' | 'packing';
	members: Member[];
	task: Task | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState('');
	const [assignees, setAssignees] = useState<string[]>([]);

	useEffect(() => {
		if (!open) return;
		setLabel(task?.label ?? '');
		setAssignees(task ? task.people.map((p) => p.id) : []);
	}, [open, task]);

	const save = useMutation(
		async () => {
			const body = {
				label,
				kind,
				assignees: kind === 'packing' ? [] : assignees,
				// The version this sheet opened on, so a save that would silently
				// overwrite somebody else's is refused instead.
				version: task?.version
			};
			if (task) {
				await api(`/trips/${tripId}/pretrip/tasks/${task.id}`, { method: 'PUT', body });
			} else {
				await api(`/trips/${tripId}/pretrip/tasks`, { method: 'POST', body });
			}
			onSaved();
		},
		{ fallback: copy.preparation.taskDialog.fallback }
	);

	const remove = useMutation(
		async () => {
			if (!task) return;
			await api(`/trips/${tripId}/pretrip/tasks/${task.id}`, { method: 'DELETE' });
			onSaved();
		},
		{ fallback: copy.preparation.saveFallback }
	);

	return (
		<Sheet open={open} title={copy.preparation.taskDialog.title(kind, !!task)} onClose={onClose}>
			<Field label={copy.preparation.taskDialog.labelField} value={label} onChangeText={setLabel} />

			{kind === 'task' ? (
				<View style={{ gap: space.xs }}>
					<Text style={type.small}>{copy.preparation.taskDialog.assignPlaceholder}</Text>
					<MemberPicker
						members={members}
						selected={assignees}
						onToggle={(id) =>
							setAssignees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]))
						}
					/>
				</View>
			) : null}

			<FormError message={save.error || remove.error} />
			<Button
				label={task ? copy.common.save : copy.common.add}
				onPress={() => void save.run()}
				busy={save.busy}
				disabled={!label.trim()}
			/>
			{task ? (
				<Button label="Delete" tone="danger" onPress={() => void remove.run()} busy={remove.busy} />
			) : null}
		</Sheet>
	);
}
