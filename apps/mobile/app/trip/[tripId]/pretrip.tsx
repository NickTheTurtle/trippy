import { useCallback, useEffect, useRef, useState } from 'react';
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
	Screen
} from '../../../src/ui';
import { CheckBox, SegmentedControl } from '../../../src/ui/controls';
import { PullDown } from '../../../src/ui/PullDown';
import {
	viewAsAccessibilityLabel,
	viewAsButtonLabel,
	viewAsChoices
} from '../../../src/lib/viewAs';
import { TaskSheet } from '../../../src/screens/TaskSheet';
import { CostSheet } from '../../../src/screens/CostSheet';
import { DoneSheet } from '../../../src/screens/DoneSheet';
import { Tag } from '../../../src/ui/marks';
import { useToast } from '../../../src/ui/Toast';
import { useTripAddAction } from '../../../src/ui/TripAddAction';
import { color, rowInset, space, type } from '../../../src/theme';
import { AppSymbol } from '../../../src/ui/Symbol';
import { tripTab } from '../../../src/ui/nativeTabs';

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

export default tripTab(Pretrip);

function Pretrip() {
	const tripId = useTripId();
	const { data, error, loading, reload } = useApi<Data>(`/trips/${tripId}/pretrip`);
	useLiveSection(['tasks', 'costs', 'members', 'trip'], reload);
	const [section, setSection] = useState<Section>('tasks');
	const [editingTask, setEditingTask] = useState<Task | null>(null);
	const [addingTask, setAddingTask] = useState(false);
	const [editingCost, setEditingCost] = useState<CostItem | null>(null);
	const [addingCost, setAddingCost] = useState(false);
	const [viewAs, setViewAs] = useState('');
	useTripAddAction(
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
					items={SECTIONS.map((key) => ({ key, label: copy.preparation.mobileSections[key] }))}
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
	// The "who has finished" sheet. The id stays set after it closes so the
	// list does not empty while the sheet slides away; the task itself is read
	// from the live list, so ticks made elsewhere show in it as they land.
	const [doneId, setDoneId] = useState<string | null>(null);
	const [doneOpen, setDoneOpen] = useState(false);
	const doneOpenRef = useRef(false);
	doneOpenRef.current = doneOpen;
	const doneTask = doneId ? (list.find((task) => task.id === doneId) ?? null) : null;
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
		// While the sheet is up the refusal is pinned in it instead: the toast
		// renders under the Modal on iOS.
		if (toggle.error && !doneOpenRef.current) toast.error(toggle.error);
	}, [toggle.error, toast]);
	const doneChain = useRef<Promise<void>>(Promise.resolve());
	const openDone = (task: Task) => {
		toggle.reset();
		setDoneId(task.id);
		setDoneOpen(true);
	};
	const closeDone = () => {
		setDoneOpen(false);
		toggle.reset();
	};
	// A task deleted or cleared of its people while its sheet is up takes the
	// sheet with it, and the toasts come back.
	const doneGone = !doneTask || doneTask.people.length === 0;
	useEffect(() => {
		if (doneOpen && doneGone) setDoneOpen(false);
	}, [doneOpen, doneGone]);

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
					kind="tasks"
					onAdd={others.length === 0 ? onAdd : undefined}
					onToggle={(steps) => void toggle.run(steps)}
					onEdit={onEdit}
					onDone={openDone}
				/>
			) : null}
			{others.length > 0 || mine.length === 0 ? (
				<TaskCard
					title={
						mine.length > 0 ? copy.preparation.myTasks.othersTitle : copy.preparation.sections[kind]
					}
					items={others}
					kind={kind}
					onAdd={onAdd}
					onToggle={(steps) => void toggle.run(steps)}
					onEdit={onEdit}
					onDone={openDone}
				/>
			) : null}
			{/* Mounted for as long as the list is, and shown by `open`, so the
			    Modal is presented by flipping `visible` rather than by mounting
			    one already visible. */}
			<DoneSheet
				open={doneOpen && !doneGone}
				task={doneTask}
				me={data.me}
				error={doneOpen ? toggle.error : null}
				onToggle={(userId, done) => {
					if (!doneTask) return;
					const step = { taskId: doneTask.id, userId, done };
					// One chain of writes, each started after the last has answered.
					// `useMutation` does not queue, so two quick taps on one name sent
					// both at once and the server could apply them out of order, leaving
					// the saved state opposite to the last tick shown.
					doneChain.current = doneChain.current.then(() => toggle.run([step]).then(() => {}));
				}}
				onClose={closeDone}
			/>
		</>
	);
}

function TaskCard({
	title,
	items,
	kind,
	onToggle,
	onEdit,
	onDone
}: {
	title: string;
	items: Task[];
	kind: 'tasks' | 'packing';
	onAdd?: () => void;
	onToggle: (steps: { taskId: string; userId?: string; done: boolean }[]) => void;
	onEdit: (task: Task) => void;
	onDone: (task: Task) => void;
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
							kind={kind}
							onToggle={onToggle}
							onEdit={() => onEdit(task)}
							onDone={() => onDone(task)}
						/>
					))}
				</>
			)}
		</InsetSection>
	);
}

/**
 * One task on one line: the box, the label, any flag, then "13/20 done".
 *
 * Who has finished lives behind that count, in a sheet, rather than as a name
 * per person under the label. The names said everything at a glance on a
 * small trip, but twenty of them wrapped each row over four lines and buried
 * the label; the count is the part that gets read (web TaskList.tsx, same
 * reasoning). The row is not itself pressable: the box, the label and the
 * count are three sibling controls, so each keeps its own accessibility
 * element and a press on the count never also opens the edit sheet.
 */
function TaskRow({
	task,
	kind,
	onToggle,
	onEdit,
	onDone,
	last
}: {
	task: Task;
	kind: 'tasks' | 'packing';
	onToggle: (steps: { taskId: string; userId?: string; done: boolean }[]) => void;
	onEdit: () => void;
	onDone: () => void;
	last: boolean;
}) {
	const assigned = task.people.length > 0;
	const state = task.done ? 'on' : task.doneCount > 0 ? 'part' : 'off';
	const summary = assigned
		? copy.preparation.taskList.doneSummary(task.doneCount, task.people.length)
		: null;
	return (
		<GroupedRow
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
			trailing={
				task.flag || summary ? (
					<View style={styles.trailing}>
						{task.flag ? <Tag label={task.flag} tone="warn" /> : null}
						{summary ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`${copy.preparation.taskList.doneMenuLabel(task.label)}, ${summary}`}
								onPress={onDone}
								hitSlop={{ top: 10, bottom: 10, left: 6, right: 8 }}
								style={({ pressed }) => [styles.summary, { opacity: pressed ? 0.5 : 1 }]}
							>
								<Text style={type.faint}>{summary}</Text>
								<AppSymbol
									name="chevron.up.chevron.down"
									fallback="chevron-expand"
									size={11}
									color={color.inkFaint}
								/>
							</Pressable>
						) : null}
					</View>
				) : undefined
			}
		>
			<Pressable
				onPress={onEdit}
				hitSlop={6}
				accessibilityRole="button"
				accessibilityLabel={copy.preparation.taskList.editLabel(
					kind === 'packing' ? 'packing' : 'task',
					task.label
				)}
			>
				<Text
					numberOfLines={2}
					style={{
						...type.body,
						color: task.done ? color.inkFaint : color.ink,
						textDecorationLine: task.done ? 'line-through' : 'none'
					}}
				>
					{task.label}
				</Text>
			</Pressable>
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
					{/* Beside the figure it changes, as on Expenses: reading as one
					    person turns Per person into their share and filters the list. */}
					{data.members.length >= 2 ? (
						<PullDown
							variant="pill"
							label={viewAsButtonLabel(viewAs, data.members, data.me)}
							accessibilityLabel={viewAsAccessibilityLabel(viewAs, data.members, data.me)}
							title={copy.viewAs.label}
							options={viewAsChoices(data.members, data.me)}
							value={viewAs}
							onPick={onViewAs}
						/>
					) : null}
				</View>
			</InsetSection>
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
		<View style={{ flex: 1, gap: 2, minWidth: 0 }}>
			<Text style={type.footnote} numberOfLines={1}>
				{label}
			</Text>
			<Text style={type.title3} numberOfLines={1} adjustsFontSizeToFit>
				{value}
			</Text>
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

function shareLabel(members: Member[], id: string, me: string): string {
	return id === me
		? copy.viewAs.yourShare
		: copy.viewAs.share(members.find((m) => m.id === id)?.name ?? '');
}

const styles = {
	trailing: {
		flexDirection: 'row' as const,
		alignItems: 'center' as const,
		gap: space.sm,
		flexShrink: 0
	},
	summary: {
		flexDirection: 'row' as const,
		alignItems: 'center' as const,
		gap: 4
	},
	stats: {
		flexDirection: 'row' as const,
		alignItems: 'center' as const,
		gap: space.md,
		paddingHorizontal: rowInset,
		paddingVertical: space.md
	}
};
