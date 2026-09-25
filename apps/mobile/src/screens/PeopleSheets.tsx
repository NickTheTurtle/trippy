import { useEffect, useMemo, useState } from 'react';
import { Text } from 'react-native';
import { copy } from '@trippy/copy';
import { api } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { useAuth } from '../auth';
import { DestructiveRow, Field, InsetSection, ListRow } from '../ui';
import { ChecklistRow } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { color, radius, type } from '../theme';

export type Person = {
	id: string;
	name: string;
	email: string;
	role: string;
	placeholder: boolean;
	seeded: boolean;
	invitedEmail?: string | null;
};
export type Crew = { id: string; name: string; color: string; members: string[]; locked: boolean };

export function AddPersonSheet({
	open,
	tripId,
	onClose,
	onDone
}: {
	open: boolean;
	tripId: string;
	onClose: () => void;
	onDone: (message: string) => void;
}) {
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	useEffect(() => {
		if (!open) return;
		setName('');
		setEmail('');
		add.reset();
	}, [open]);
	const add = useMutation(
		async () => {
			const { message } = await api<{ message: string }>(`/trips/${tripId}/people/invites`, {
				method: 'POST',
				body: { name, email }
			});
			onDone(message);
		},
		{ fallback: copy.people.add.fallback }
	);
	return (
		<Sheet
			open={open}
			title={copy.people.add.title}
			onClose={onClose}
			onPrimary={() => void add.run()}
			primaryLabel={copy.common.add}
			primaryBusyLabel={copy.common.adding}
			primaryBusy={add.busy}
			primaryDisabled={!name.trim()}
		>
			<InsetSection error={add.error}>
				<Field
					variant="row"
					label={copy.people.add.nameLabel}
					value={name}
					onChangeText={setName}
					autoCapitalize="words"
				/>
				<Field
					variant="row"
					label={`${copy.people.add.emailLabel}${copy.ui.field.optionalSuffix}`}
					value={email}
					onChangeText={setEmail}
					autoCapitalize="none"
					keyboardType="email-address"
					last
				/>
			</InsetSection>
		</Sheet>
	);
}

export function MemberSheet({
	open,
	tripId,
	person,
	me,
	organizer,
	onClose,
	onSaved,
	onDone
}: {
	open: boolean;
	tripId: string;
	person: Person | null;
	me: string;
	organizer: boolean;
	onClose: () => void;
	onSaved: () => void;
	onDone: (message: string) => void;
}) {
	const { refresh } = useAuth();
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [confirmDelete, setConfirmDelete] = useState(false);
	const own = !!person && person.id === me && !person.placeholder && !person.seeded;
	const editable = !!person && (person.placeholder || person.seeded || own);
	const editableEmail = !!person?.placeholder;
	const canRemove = !!person && person.id !== me && organizer;
	useEffect(() => {
		if (!open || !person) return;
		setName(person.name);
		setEmail(person.invitedEmail ?? '');
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, person?.id]);
	const save = useMutation(
		async () => {
			if (!person) return;
			if (editable && name.trim() !== person.name) {
				if (own) {
					await api('/account/profile', { method: 'PATCH', body: { name } });
					await refresh();
				} else {
					await api(`/trips/${tripId}/people/${person.id}`, { method: 'PATCH', body: { name } });
				}
			}
			const next = email.trim().toLowerCase();
			if (editableEmail && next !== (person.invitedEmail ?? '')) {
				const { message } = await api<{ message: string }>(
					`/trips/${tripId}/people/${person.id}/email`,
					{ method: 'PATCH', body: { email: next } }
				);
				onDone(message);
			}
		},
		{ fallback: copy.people.edit.fallback, onSuccess: onSaved }
	);
	const remove = useMutation(
		async () => {
			if (!person) return;
			await api(`/trips/${tripId}/people/${person.id}`, { method: 'DELETE' });
		},
		{ fallback: copy.people.edit.fallback, onSuccess: onSaved }
	);
	if (!person) return null;
	return (
		<>
			<Sheet
				open={open && !confirmDelete}
				title={editable ? copy.people.edit.title : person.name}
				onClose={onClose}
				onPrimary={editable ? () => void save.run() : undefined}
				primaryLabel={editable ? copy.common.save : undefined}
				primaryBusyLabel={copy.common.saving}
				primaryBusy={save.busy}
				primaryDisabled={editable && !name.trim()}
			>
				{editable ? (
					<InsetSection error={save.error}>
						<Field
							variant="row"
							label={copy.people.edit.nameLabel}
							value={name}
							onChangeText={setName}
							last={!editableEmail}
						/>
						{editableEmail ? (
							<Field
								variant="row"
								label={`${copy.people.edit.emailLabel}${copy.ui.field.optionalSuffix}`}
								value={email}
								onChangeText={setEmail}
								autoCapitalize="none"
								keyboardType="email-address"
								last
							/>
						) : null}
					</InsetSection>
				) : (
					<InsetSection>
						<ListRow title={person.email} accessory="none" last />
					</InsetSection>
				)}
				{canRemove ? (
					<InsetSection>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(person.name)}
							onPress={() => setConfirmDelete(true)}
						/>
					</InsetSection>
				) : null}
			</Sheet>
			<ConfirmSheet
				open={confirmDelete}
				title={copy.common.deleteTitle(person.name)}
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

export function CrewSheet({
	open,
	tripId,
	crew,
	people,
	onClose,
	onDone
}: {
	open: boolean;
	tripId: string;
	crew: Crew | null;
	people: Person[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [name, setName] = useState('');
	const [members, setMembers] = useState<string[]>([]);
	const [confirmDelete, setConfirmDelete] = useState(false);
	useEffect(() => {
		if (!open) return;
		setName(crew?.name ?? '');
		setMembers(crew ? [...crew.members].filter((id) => people.some((p) => p.id === id)) : []);
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, crew?.id]);
	const base = `/trips/${tripId}/people/crews`;
	const save = useMutation(
		() =>
			api(crew ? `${base}/${crew.id}` : base, {
				method: crew ? 'PATCH' : 'POST',
				body: { name: name.trim(), people: members }
			}),
		{ fallback: copy.people.crews.fallback, onSuccess: onDone }
	);
	const remove = useMutation(() => api(`${base}/${crew?.id}`, { method: 'DELETE' }), {
		fallback: copy.people.crews.fallback,
		onSuccess: onDone
	});
	return (
		<>
			<Sheet
				open={open && !confirmDelete}
				title={crew ? copy.people.crews.editTitle : copy.people.crews.addTitle}
				onClose={onClose}
				onPrimary={() => void save.run()}
				primaryLabel={crew ? copy.common.save : copy.common.add}
				primaryBusyLabel={crew ? copy.common.saving : copy.common.adding}
				primaryBusy={save.busy}
				primaryDisabled={!name.trim()}
			>
				<InsetSection error={save.error}>
					<Field
						variant="row"
						label={copy.people.crews.nameLabel}
						value={name}
						onChangeText={setName}
						last
					/>
				</InsetSection>
				<MemberMultiSelect
					label={copy.people.crews.peopleLabel}
					people={people}
					selected={members}
					onChange={setMembers}
				/>
				{crew && !crew.locked ? (
					<InsetSection>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(crew.name)}
							onPress={() => setConfirmDelete(true)}
						/>
					</InsetSection>
				) : null}
			</Sheet>
			<ConfirmSheet
				open={confirmDelete}
				title={crew ? copy.common.deleteTitle(crew.name) : ''}
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

function MemberMultiSelect({
	label,
	people,
	selected,
	onChange
}: {
	label: string;
	people: Person[];
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const toggle = (id: string) => {
		const next = new Set(selectedSet);
		if (!next.delete(id)) next.add(id);
		onChange([...next]);
	};
	return (
		<InsetSection title={label}>
			{people.map((person, index) => (
				<ChecklistRow
					key={person.id}
					label={person.name}
					checked={selectedSet.has(person.id)}
					onPress={() => toggle(person.id)}
					last={index === people.length - 1}
				/>
			))}
		</InsetSection>
	);
}

export function Tag({ label }: { label: string }) {
	return (
		<Text
			style={{
				...type.faint,
				color: color.accentInk,
				backgroundColor: color.accentSoft,
				borderRadius: radius.sm,
				paddingHorizontal: 6,
				paddingVertical: 1,
				overflow: 'hidden',
				fontSize: 11
			}}
		>
			{label}
		</Text>
	);
}
