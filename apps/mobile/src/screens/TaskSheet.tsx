import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Field, FormError } from '../ui';
import { CheckBox } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { SheetFooter } from '../ui/SheetFooter';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { color, fieldLabel, radius, space, type } from '../theme';

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
	}, [open, task]);

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
				open={open && !confirmDelete}
				title={copy.preparation.taskDialog.title(kind, !!task)}
				onClose={onClose}
			>
				<Field
					label={copy.preparation.taskDialog.labelField}
					value={label}
					onChangeText={setLabel}
				/>
				{kind === 'task' ? (
					<AssigneePicker
						members={members}
						crews={crews}
						selected={assignees}
						onChange={setAssignees}
					/>
				) : null}
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={task ? copy.common.save : copy.common.add}
					primaryBusyLabel={task ? copy.common.saving : copy.common.adding}
					primaryBusy={save.busy}
					primaryDisabled={!label.trim()}
					onPrimary={() => void save.run()}
					destructiveLabel={task ? copy.common.deleteLabel(task.label) : undefined}
					onDestructive={task ? () => setConfirmDelete(true) : undefined}
				/>
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
		<View style={{ gap: space.sm }}>
			<Text style={fieldLabel}>
				{copy.preparation.taskDialog.assignLabel}
				{copy.ui.field.optionalSuffix}
			</Text>
			{members.length > 2 ? (
				<View style={{ flexDirection: 'row', gap: space.sm }}>
					<Chip
						label={copy.preparation.taskDialog.selectEveryone}
						onPress={() => setAll(members.map((m) => m.id))}
					/>
					<Chip label={copy.preparation.taskDialog.clear} onPress={() => onChange([])} />
				</View>
			) : null}
			{crews.length ? (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
				>
					<View style={{ flexDirection: 'row', gap: space.sm }}>
						{crews.map((crew) => (
							<Chip key={crew.id} label={crew.name} onPress={() => setAll(crew.members)} />
						))}
					</View>
				</ScrollView>
			) : null}
			<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
				{members.map((member) => {
					const on = selectedSet.has(member.id);
					return (
						<Pressable
							key={member.id}
							onPress={() => toggle(member.id)}
							style={({ pressed }) => ({
								flexDirection: 'row',
								alignItems: 'center',
								gap: space.xs,
								paddingHorizontal: space.sm,
								paddingVertical: 6,
								borderRadius: 999,
								borderWidth: 1,
								borderColor: on ? color.accent : color.line,
								backgroundColor: on ? color.accentSoft : color.surface,
								opacity: pressed ? 0.7 : 1
							})}
						>
							<CheckBox checked={on} label={member.name} onPress={() => toggle(member.id)} />
							<Text style={type.small}>{member.name}</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
	return (
		<Pressable
			onPress={onPress}
			style={({ pressed }) => ({
				paddingHorizontal: space.md,
				paddingVertical: 7,
				borderRadius: radius.md,
				borderWidth: 1,
				borderColor: color.line,
				backgroundColor: pressed ? color.surface2 : color.surface
			})}
		>
			<Text style={type.small}>{label}</Text>
		</Pressable>
	);
}
