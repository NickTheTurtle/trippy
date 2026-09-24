import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { cap } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Field, FormError } from '../ui';
import { CheckBox, Picker, SearchablePicker } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { SheetFooter } from '../ui/SheetFooter';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { color, fieldLabel, radius, space, type } from '../theme';
import { currencyName } from '@trippy/core/currency-names';

type Member = { id: string; name: string };
type Crew = { id: string; name: string; members: string[]; locked?: boolean };
type CostItem = {
	id: string;
	category: string;
	label: string;
	amountCents: number;
	currency: string;
	people: { id: string; name: string }[];
};

function currencyOptions(currencies: readonly string[]) {
	return currencies.map((code) => ({ key: code, label: code, detail: currencyName(code) }));
}

export function CostSheet({
	open,
	tripId,
	currency,
	currencies,
	categories,
	members,
	crews,
	item,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	currency: string;
	currencies: string[];
	categories: string[];
	members: Member[];
	crews: Crew[];
	item: CostItem | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState('');
	const [amount, setAmount] = useState('');
	const [cur, setCur] = useState(currency);
	const [category, setCategory] = useState(categories[0] ?? '');
	const [assignees, setAssignees] = useState<string[]>([]);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		if (!open) return;
		setLabel(item?.label ?? '');
		setAmount(item ? String(item.amountCents / 100) : '');
		setCur(item?.currency || currency);
		setCategory(item?.category ?? categories[0] ?? '');
		setAssignees(item ? item.people.map((p) => p.id) : []);
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, item, categories, currency]);

	const save = useMutation(
		async () => {
			const value = Number(amount.trim());
			if (!Number.isFinite(value)) throw new ApiError(400, copy.preparation.costDialog.fallback);
			const body = { label, category, amount: value, currency: cur, assignees };
			if (item) await api(`/trips/${tripId}/pretrip/costs/${item.id}`, { method: 'PUT', body });
			else await api(`/trips/${tripId}/pretrip/costs`, { method: 'POST', body });
		},
		{ fallback: copy.preparation.costDialog.fallback, onSuccess: onSaved }
	);

	const remove = useMutation(
		async () => {
			if (!item) return;
			await api(`/trips/${tripId}/pretrip/costs/${item.id}`, { method: 'DELETE' });
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
				title={item ? copy.preparation.costDialog.editTitle : copy.preparation.costDialog.addTitle}
				onClose={onClose}
			>
				<Field
					label={copy.preparation.costDialog.labelField}
					value={label}
					onChangeText={setLabel}
				/>
				<Field
					label={copy.preparation.costDialog.amountLabel}
					value={amount}
					onChangeText={setAmount}
					keyboardType="decimal-pad"
				/>
				<SearchablePicker
					label={copy.preparation.costDialog.currencyLabel}
					value={cur}
					options={currencyOptions(currencies)}
					onPick={setCur}
					noMatches={copy.ui.currencyPicker.noMatches}
				/>
				<Picker
					label={copy.preparation.costDialog.categoryLabel}
					options={categories.map((c) => ({ key: c, label: cap(c) }))}
					value={category}
					onPick={setCategory}
				/>
				<AssigneePicker
					members={members}
					crews={crews}
					selected={assignees}
					onChange={setAssignees}
				/>
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={item ? copy.common.save : copy.common.add}
					primaryBusyLabel={item ? copy.common.saving : copy.common.adding}
					primaryBusy={save.busy}
					primaryDisabled={!label.trim()}
					onPrimary={() => void save.run()}
					destructiveLabel={item ? copy.common.deleteLabel(item.label) : undefined}
					onDestructive={item ? () => setConfirmDelete(true) : undefined}
				/>
			</Sheet>
			<ConfirmSheet
				open={!!item && confirmDelete}
				title={item ? copy.common.deleteTitle(item.label) : ''}
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
				{copy.preparation.costDialog.forLabel}
				{copy.ui.field.optionalSuffix}
			</Text>
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
			{selected.length === 0 ? (
				<Text style={type.faint}>{copy.preparation.costDialog.forEveryone}</Text>
			) : null}
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
