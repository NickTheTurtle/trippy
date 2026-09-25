import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { cap, formatMoney } from '@trippy/copy/format';
import { amountFor, isFor, totalFor } from '@trippy/core/pretrip-shares';
import { api } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import {
	Button,
	EmptyState,
	FormError,
	GroupedRow,
	InsetSection,
	Loading,
	Screen,
	SectionHeader
} from '../../../src/ui';
import { CheckBox, Picker, SegmentedControl } from '../../../src/ui/controls';
import { TaskSheet } from '../../../src/screens/TaskSheet';
import { CostSheet } from '../../../src/screens/CostSheet';
import { useToast } from '../../../src/ui/Toast';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import { color, rowInset, space, type } from '../../../src/theme';
import { AppSymbol } from '../../../src/ui/Symbol';

type Member = { id: string; name: string };
type Crew = { id: string; name: string; members: string[]; locked?: boolean };
type TaskPerson = { id: string; name: string; done: boolean };
type Task = {
	id: string;
	kind: string;
	label: string;
	flag: string | null;
	people: TaskPerson[];
	shared: boolean;
	done: boolean;
	doneCount: number;
	version: number;
};
type CostPerson = { id: string; name: string };
type CostItem = {
	id: string;
	category: string;
	label: string;
	amountCents: number;
	currency: string;
	homeCents: number;
	people: CostPerson[];
};

type Data = {
	me: string;
	members: Member[];
	crews: Crew[];
	tasks: Task[];
	packing: Task[];
	currency: string;
	currencies: string[];
	memberCount: number;
	categories: string[];
	budget: { items: CostItem[]; grandTotal: number };
};

const SECTIONS = ['tasks', 'packing', 'costs'] as const;
type Section = (typeof SECTIONS)[number];

export default function Pretrip() {
	const tripId = useTripId();
	const { data, error, loading, reload } = useApi<Data>(`/trips/${tripId}/pretrip`);
	useLiveSection(['tasks', 'costs', 'members', 'trip'], reload);
	const [section, setSection] = useState<Section>('tasks');
	const [editingTask, setEditingTask] = useState<Task | null>(null);
	const [addingTask, setAddingTask] = useState(false);
	const [editingCost, setEditingCost] = useState<CostItem | null>(null);
	const [addingCost, setAddingCost] = useState(false);
	const [viewAs, setViewAs] = useState('');
	useTripHeaderAction(
		useCallback(() => {
			if (section === 'costs') setAddingCost(true);
			else setAddingTask(true);
		}, [section])
	);

	if (loading && !data) return <Loading />;
	if (!data) {
		return (
			<Screen>
				<FormError message={error ?? copy.api.loadFailed} />
				<Button label={copy.api.retry} onPress={reload} />
			</Screen>
		);
	}

	const grand = data.budget.grandTotal;
	const perPerson = data.memberCount ? grand / data.memberCount : grand;
	const shownTotal = totalFor(data.budget.items, viewAs, data.memberCount);

	return (
		<>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				{error ? <FormError message={error} /> : null}
				<SegmentedControl
					items={SECTIONS.map((key) => ({ key, label: copy.preparation.sections[key] }))}
					active={section}
					onPick={(key) => setSection(key as Section)}
				/>

				{section === 'costs' ? (
					<Costs
						data={data}
						viewAs={viewAs}
						onViewAs={setViewAs}
						onEdit={setEditingCost}
						grand={grand}
						perPerson={perPerson}
						shownTotal={shownTotal}
					/>
				) : (
					<Tasks
						tripId={tripId}
						data={data}
						kind={section}
						onAdd={() => setAddingTask(true)}
						onEdit={setEditingTask}
						reload={reload}
					/>
				)}
			</Screen>

			{addingTask || editingTask ? (
				<TaskSheet
					open
					tripId={tripId}
					kind={section === 'packing' ? 'packing' : 'task'}
					members={data.members}
					crews={data.crews}
					task={editingTask}
					onClose={() => {
						setAddingTask(false);
						setEditingTask(null);
					}}
					onSaved={() => {
						setAddingTask(false);
						setEditingTask(null);
						reload();
					}}
					onConflict={reload}
				/>
			) : null}

			{addingCost || editingCost ? (
				<CostSheet
					open
					tripId={tripId}
					currency={data.currency}
					currencies={data.currencies}
					categories={data.categories}
					members={data.members}
					crews={data.crews}
					item={editingCost}
					onClose={() => {
						setAddingCost(false);
						setEditingCost(null);
					}}
					onSaved={() => {
						setAddingCost(false);
						setEditingCost(null);
						reload();
					}}
				/>
			) : null}
		</>
	);
}

function Tasks({
	tripId,
	data,
	kind,
	onAdd,
	onEdit,
	reload
}: {
	tripId: string;
	data: Data;
	kind: 'tasks' | 'packing';
	onAdd: () => void;
	onEdit: (task: Task) => void;
	reload: () => void;
}) {
	const list = kind === 'packing' ? data.packing : data.tasks;
	const toast = useToast();
	const toggle = useMutation(
		async (steps: { taskId: string; userId?: string; done: boolean }[]) => {
			try {
				for (const step of steps) {
					await api(`/trips/${tripId}/pretrip/tasks/${step.taskId}/toggle`, {
						method: 'POST',
						body: step.userId ? { userId: step.userId, done: step.done } : { done: step.done }
					});
				}
			} finally {
				// A refusal part-way leaves the earlier ticks saved, so the row is
				// reread either way. Live updates would repair it too, but not while
				// they are off.
				reload();
			}
		},
		{ fallback: copy.preparation.saveFallback }
	);
	useEffect(() => {
		if (toggle.error) toast.error(toggle.error);
	}, [toggle.error, toast]);

	const mine =
		kind === 'tasks' ? list.filter((task) => task.people.some((p) => p.id === data.me)) : [];
	const others = kind === 'tasks' ? list.filter((task) => !mine.includes(task)) : list;

	if (list.length === 0) return <EmptyState graphic message={copy.common.nothingAdded} />;

	return (
		<>
			{mine.length > 0 ? (
				<TaskCard
					title={copy.preparation.myTasks.title}
					items={mine}
					me={data.me}
					kind="tasks"
					onAdd={others.length === 0 ? onAdd : undefined}
					onToggle={(steps) => void toggle.run(steps)}
					onEdit={onEdit}
				/>
			) : null}
			{others.length > 0 || mine.length === 0 ? (
				<TaskCard
					title={
						mine.length > 0 ? copy.preparation.myTasks.othersTitle : copy.preparation.sections[kind]
					}
					items={others}
					me={data.me}
					kind={kind}
					onAdd={onAdd}
					onToggle={(steps) => void toggle.run(steps)}
					onEdit={onEdit}
				/>
			) : null}
		</>
	);
}

function TaskCard({
	title,
	items,
	me,
	kind,
	onAdd,
	onToggle,
	onEdit
}: {
	title: string;
	items: Task[];
	me: string;
	kind: 'tasks' | 'packing';
	onAdd?: () => void;
	onToggle: (steps: { taskId: string; userId?: string; done: boolean }[]) => void;
	onEdit: (task: Task) => void;
}) {
	return (
		<InsetSection title={title}>
			{items.length === 0 ? (
				<EmptyState message={copy.common.nothingAdded} />
			) : (
				<>
					{items.map((task, index) => (
						<TaskRow
							key={task.id}
							task={task}
							last={index === items.length - 1}
							me={me}
							kind={kind}
							onToggle={onToggle}
							onEdit={() => onEdit(task)}
						/>
					))}
				</>
			)}
		</InsetSection>
	);
}

function TaskRow({
	task,
	me,
	kind,
	onToggle,
	onEdit,
	last
}: {
	task: Task;
	me: string;
	kind: 'tasks' | 'packing';
	onToggle: (steps: { taskId: string; userId?: string; done: boolean }[]) => void;
	onEdit: () => void;
	last: boolean;
}) {
	const assigned = task.people.length > 0;
	const state = task.done ? 'on' : task.doneCount > 0 ? 'part' : 'off';
	const summary = assigned
		? copy.preparation.taskList.doneSummary(task.doneCount, task.people.length)
		: null;
	return (
		<GroupedRow
			alignTop
			last={last}
			leading={
				<CheckBox
					checked={state === 'on'}
					state={state === 'on' ? 'checked' : state === 'part' ? 'mixed' : 'unchecked'}
					label={
						assigned
							? copy.preparation.taskList.allBoxLabel(task.done, task.label)
							: copy.preparation.taskList.sharedBoxLabel(task.done, task.label)
					}
					onPress={() => {
						const want = !task.done;
						if (assigned) {
							const steps = task.people
								.filter((person) => person.done !== want)
								.map((person) => ({ taskId: task.id, userId: person.id, done: want }));
							if (steps.length) onToggle(steps);
						} else {
							onToggle([{ taskId: task.id, done: want }]);
						}
					}}
				/>
			}
		>
			<Pressable
				onPress={onEdit}
				hitSlop={6}
				accessibilityLabel={copy.preparation.taskList.editLabel(
					kind === 'packing' ? 'packing' : 'task',
					task.label
				)}
				style={{ gap: 2 }}
			>
				<Text
					style={{
						...type.body,
						color: task.done ? color.inkFaint : color.ink,
						textDecorationLine: task.done ? 'line-through' : 'none'
					}}
				>
					{task.label}
				</Text>
				{summary ? <Text style={type.faint}>{summary}</Text> : null}
			</Pressable>
			{task.flag ? <Text style={{ ...type.faint, color: color.warn }}>{task.flag}</Text> : null}
			{assigned ? (
				<View
					style={{
						flexDirection: 'row',
						flexWrap: 'wrap',
						columnGap: space.sm,
						rowGap: 2,
						marginTop: space.xs
					}}
				>
					{task.people.map((p) => (
						<Pressable
							key={p.id}
							accessibilityRole="checkbox"
							accessibilityState={{ checked: p.done }}
							accessibilityLabel={p.name + (p.id === me ? copy.preparation.youSuffix : '')}
							onPress={() => onToggle([{ taskId: task.id, userId: p.id, done: !p.done }])}
							hitSlop={4}
						>
							<Text
								style={{
									...type.faint,
									color: p.done ? color.accentInk : color.inkFaint,
									textDecorationLine: p.done ? 'line-through' : 'none'
								}}
							>
								{p.name}
								{p.id === me ? copy.preparation.youSuffix : ''}
							</Text>
						</Pressable>
					))}
				</View>
			) : null}
		</GroupedRow>
	);
}

function Costs({
	data,
	viewAs,
	onViewAs,
	onEdit,
	grand,
	perPerson,
	shownTotal
}: {
	data: Data;
	viewAs: string;
	onViewAs: (id: string) => void;
	onEdit: (item: CostItem) => void;
	grand: number;
	perPerson: number;
	shownTotal: number;
}) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const fmt = (cents: number) => formatMoney(cents, data.currency, { whole: true });
	if (data.budget.items.length === 0) {
		return <EmptyState graphic message={copy.common.nothingAdded} />;
	}
	const shown = viewAs
		? data.budget.items.filter((item) => isFor(item, viewAs))
		: data.budget.items;
	return (
		<>
			<InsetSection>
				<View style={styles.stats}>
					<Stat label={copy.preparation.tripTotal} value={fmt(grand)} />
					<Stat
						label={viewAs ? shareLabel(data.members, viewAs, data.me) : copy.preparation.perPerson}
						value={fmt(viewAs ? shownTotal : perPerson)}
					/>
				</View>
			</InsetSection>
			<ViewAs members={data.members} me={data.me} value={viewAs} onChange={onViewAs} />
			<InsetSection>
				{data.categories.map((category) => {
					const rows = shown.filter((item) => item.category === category);
					const subtotal = rows.reduce(
						(sum, item) => sum + amountFor(item, viewAs, data.memberCount),
						0
					);
					const expanded = rows.length > 0 && (open[category] ?? true);
					return (
						<View key={category}>
							<GroupedRow
								leading={
									<View style={{ width: 14 }}>
										{rows.length ? (
											<AppSymbol
												name={expanded ? 'chevron.down' : 'chevron.right'}
												fallback={expanded ? 'chevron-down' : 'chevron-forward'}
												size={13}
												color={color.inkFaint}
											/>
										) : null}
									</View>
								}
								trailing={<Text style={type.subhead}>{fmt(subtotal)}</Text>}
								onPress={
									rows.length ? () => setOpen((o) => ({ ...o, [category]: !expanded })) : undefined
								}
								accessibilityLabel={`${cap(category)}, ${fmt(subtotal)}`}
								accessibilityState={rows.length ? { expanded } : undefined}
							>
								<Text style={type.head}>{cap(category)}</Text>
							</GroupedRow>
							{expanded
								? rows.map((item) => (
										<CostRow
											key={item.id}
											item={item}
											home={data.currency}
											viewAs={viewAs}
											memberCount={data.memberCount}
											fmt={fmt}
											onPress={() => onEdit(item)}
										/>
									))
								: null}
						</View>
					);
				})}
				<GroupedRow
					last
					trailing={<Text style={type.head}>{fmt(shownTotal)}</Text>}
					accessible
					accessibilityLabel={`${
						viewAs ? shareLabel(data.members, viewAs, data.me) : copy.preparation.costTable.total
					}, ${fmt(shownTotal)}`}
				>
					<Text style={type.head}>
						{viewAs ? shareLabel(data.members, viewAs, data.me) : copy.preparation.costTable.total}
					</Text>
				</GroupedRow>
			</InsetSection>
		</>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<View style={{ flex: 1, gap: 2 }}>
			<Text style={type.footnote}>{label}</Text>
			<Text style={type.title3}>{value}</Text>
		</View>
	);
}

function CostRow({
	item,
	home,
	viewAs,
	memberCount,
	fmt,
	onPress
}: {
	item: CostItem;
	home: string;
	viewAs: string;
	memberCount: number;
	fmt: (cents: number) => string;
	onPress: () => void;
}) {
	const converted = !!item.currency && item.currency !== home;
	return (
		<GroupedRow
			leading={<View style={{ width: 14 }} />}
			onPress={onPress}
			accessibilityLabel={copy.common.editLabel(item.label)}
			accessory="chevron"
			trailing={
				<View style={{ alignItems: 'flex-end' }}>
					{viewAs ? (
						<>
							<Text style={type.subhead}>{fmt(amountFor(item, viewAs, memberCount))}</Text>
							<Text style={type.faint}>
								{copy.preparation.costTable.ofTotal(fmt(item.homeCents))}
							</Text>
						</>
					) : (
						<>
							<Text style={type.subhead}>
								{formatMoney(item.amountCents, item.currency || home, { whole: true })}
							</Text>
							{converted ? <Text style={type.faint}>≈ {fmt(item.homeCents)}</Text> : null}
						</>
					)}
				</View>
			}
		>
			<Text style={type.body}>{item.label}</Text>
			<Text style={type.faint}>
				{item.people.length ? item.people.map((p) => p.name).join(', ') : copy.viewAs.everyone}
			</Text>
		</GroupedRow>
	);
}

function ViewAs({
	members,
	me,
	value,
	onChange
}: {
	members: Member[];
	me: string;
	value: string;
	onChange: (id: string) => void;
}) {
	if (members.length < 2) return null;
	return (
		<View style={{ gap: 7 }}>
			<SectionHeader>{copy.viewAs.label}</SectionHeader>
			<Picker
				bleed
				options={[
					{ key: '', label: copy.viewAs.everyone },
					...members.map((m) => ({
						key: m.id,
						label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
					}))
				]}
				value={value}
				onPick={onChange}
			/>
		</View>
	);
}

function shareLabel(members: Member[], id: string, me: string): string {
	return id === me
		? copy.viewAs.yourShare
		: copy.viewAs.share(members.find((m) => m.id === id)?.name ?? '');
}

const styles = {
	stats: {
		flexDirection: 'row' as const,
		gap: space.lg,
		paddingHorizontal: rowInset,
		paddingVertical: space.md
	}
};
