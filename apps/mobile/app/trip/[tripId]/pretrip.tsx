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
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { CheckBox, Picker, SegmentedControl } from '../../../src/ui/controls';
import { TaskSheet } from '../../../src/screens/TaskSheet';
import { CostSheet } from '../../../src/screens/CostSheet';
import { useToast } from '../../../src/ui/Toast';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import { color, space, type } from '../../../src/theme';
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
						tripId={tripId}
						data={data}
						viewAs={viewAs}
						onViewAs={setViewAs}
						onAdd={() => setAddingCost(true)}
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
	const mine = task.people.find((p) => p.id === me);
	const state = task.done ? 'on' : task.doneCount > 0 ? 'part' : 'off';
	const summary = assigned
		? copy.preparation.taskList.doneSummary(task.doneCount, task.people.length)
		: null;
	return (
		<View style={{ paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: color.line }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
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
				<Pressable
					onPress={onEdit}
					style={{ flex: 1 }}
					hitSlop={6}
					accessibilityLabel={copy.preparation.taskList.editLabel(
						kind === 'packing' ? 'packing' : 'task',
						task.label
					)}
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
			</View>
			{task.flag ? (
				<Text style={{ ...type.faint, color: color.warn, marginLeft: 34 }}>{task.flag}</Text>
			) : null}
			{assigned ? (
				<View
					style={{
						flexDirection: 'row',
						flexWrap: 'wrap',
						gap: space.sm,
						marginTop: space.xs,
						marginLeft: 34
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
			) : mine ? null : null}
		</View>
	);
}

function Costs({
	tripId,
	data,
	viewAs,
	onViewAs,
	onAdd,
	onEdit,
	grand,
	perPerson,
	shownTotal
}: {
	tripId: string;
	data: Data;
	viewAs: string;
	onViewAs: (id: string) => void;
	onAdd: () => void;
	onEdit: (item: CostItem) => void;
	grand: number;
	perPerson: number;
	shownTotal: number;
}) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const fmt = (cents: number) => formatMoney(cents, data.currency, { whole: true });
	const shown = viewAs
		? data.budget.items.filter((item) => isFor(item, viewAs))
		: data.budget.items;
	return (
		<>
			<InsetSection title={copy.preparation.sections.costs}>
				<View
					style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg, padding: space.md }}
				>
					{data.budget.items.length > 0 ? (
						<>
							<View style={{ flex: 1 }}>
								<Text style={type.faint}>{copy.preparation.tripTotal}</Text>
								<Text style={type.head}>{fmt(grand)}</Text>
							</View>
							<View style={{ flex: 1 }}>
								<Text style={type.faint}>
									{viewAs ? shareLabel(data.members, viewAs, data.me) : copy.preparation.perPerson}
								</Text>
								<Text style={type.head}>{fmt(viewAs ? shownTotal : perPerson)}</Text>
							</View>
						</>
					) : (
						<View style={{ flex: 1 }} />
					)}
					<AddText onPress={onAdd} />
				</View>
			</InsetSection>
			{data.budget.items.length > 0 ? (
				<ViewAs members={data.members} me={data.me} value={viewAs} onChange={onViewAs} />
			) : null}
			<InsetSection>
				{data.budget.items.length === 0 ? (
					<EmptyState message={copy.common.nothingAdded} />
				) : (
					<View>
						{data.categories.map((category) => {
							const rows = shown.filter((item) => item.category === category);
							const subtotal = rows.reduce(
								(sum, item) => sum + amountFor(item, viewAs, data.memberCount),
								0
							);
							const expanded = rows.length > 0 && (open[category] ?? true);
							return (
								<View
									key={category}
									style={{
										borderTopWidth: 1,
										borderTopColor: color.line,
										paddingVertical: space.sm
									}}
								>
									<Pressable
										onPress={() => rows.length && setOpen((o) => ({ ...o, [category]: !expanded }))}
										style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
									>
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
										<Text style={{ ...type.body, fontWeight: '600', flex: 1 }}>
											{cap(category)}
										</Text>
										<Text style={type.small}>{fmt(subtotal)}</Text>
									</Pressable>
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
						<View style={{ flexDirection: 'row', paddingTop: space.md }}>
							<Text style={{ ...type.body, fontWeight: '700', flex: 1 }}>
								{viewAs
									? shareLabel(data.members, viewAs, data.me)
									: copy.preparation.costTable.total}
							</Text>
							<Text style={{ ...type.body, fontWeight: '700' }}>{fmt(shownTotal)}</Text>
						</View>
					</View>
				)}
			</InsetSection>
		</>
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
		<Pressable
			onPress={onPress}
			style={{
				flexDirection: 'row',
				alignItems: 'center',
				gap: space.md,
				paddingVertical: space.sm
			}}
			accessibilityLabel={copy.common.editLabel(item.label)}
		>
			<View style={{ flex: 1 }}>
				<Text style={type.body}>{item.label}</Text>
				<Text style={type.faint}>
					{item.people.length ? item.people.map((p) => p.name).join(', ') : copy.viewAs.everyone}
				</Text>
			</View>
			<View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
				{viewAs ? (
					<>
						<Text style={type.small}>{fmt(amountFor(item, viewAs, memberCount))}</Text>
						<Text style={type.faint}>
							{copy.preparation.costTable.ofTotal(fmt(item.homeCents))}
						</Text>
					</>
				) : (
					<>
						<Text style={type.small}>
							{formatMoney(item.amountCents, item.currency || home, { whole: true })}
						</Text>
						{converted ? <Text style={type.faint}>≈ {fmt(item.homeCents)}</Text> : null}
					</>
				)}
			</View>
		</Pressable>
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
		<InsetSection title={copy.viewAs.label}>
			<Picker
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
		</InsetSection>
	);
}

function AddText({ onPress }: { onPress: () => void }) {
	return (
		<Pressable onPress={onPress} hitSlop={8}>
			<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
				{copy.preparation.add}
			</Text>
		</Pressable>
	);
}

function shareLabel(members: Member[], id: string, me: string): string {
	return id === me
		? copy.viewAs.yourShare
		: copy.viewAs.share(members.find((m) => m.id === id)?.name ?? '');
}
