import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { cap, formatMoney } from '@trippy/copy/format';
import { api } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { Card, EmptyState, FormError, Head, Loading, Screen } from '../../../src/ui';
import { CheckBox, SegmentedControl } from '../../../src/ui/controls';
import { TaskSheet } from '../../../src/screens/TaskSheet';
import { CostSheet } from '../../../src/screens/CostSheet';
import { color, space, type } from '../../../src/theme';

type Member = { id: string; name: string };
type TaskPerson = { id: string; name: string; done: boolean };
type Task = {
	id: string;
	kind: string;
	label: string;
	people: TaskPerson[];
	shared: boolean;
	done: boolean;
	doneCount: number;
	/** Sent back on edit so a save over somebody else's is refused. */
	version: number;
};
type CostPerson = { id: string; name: string };
type CostItem = {
	id: string;
	category: string;
	label: string;
	amountCents: number;
	/** Blank means the trip's home currency. */
	currency: string;
	/** `amountCents` in the trip's home currency. Every total is built from this. */
	homeCents: number;
	people: CostPerson[];
};

type Data = {
	me: string;
	members: Member[];
	tasks: Task[];
	packing: Task[];
	currency: string;
	memberCount: number;
	categories: string[];
	budget: { items: CostItem[]; grandTotal: number };
};

const SECTIONS = ['tasks', 'packing', 'costs'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Preparation, as three sections behind a segmented control.
 *
 * The web page shows all three stacked under a section nav. On a phone that is
 * a very long scroll to reach the costs, so the nav becomes a real switch and
 * only one section is mounted at a time.
 */
export default function Pretrip() {
	const tripId = useTripId();
	const { data, error, loading, reload } = useApi<Data>(`/trips/${tripId}/pretrip`);
	useLiveSection(['tasks', 'costs', 'members', 'trip'], reload);
	const [section, setSection] = useState<Section>('tasks');

	if (loading && !data) return <Loading />;

	return (
		<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
			{error ? <FormError message={error} /> : null}

			<SegmentedControl
				items={SECTIONS.map((s) => ({ key: s, label: copy.preparation.sections[s] }))}
				active={section}
				onPick={(k) => setSection(k as Section)}
			/>

			{data ? (
				section === 'costs' ? (
					<Costs tripId={tripId} data={data} reload={reload} />
				) : (
					<Tasks tripId={tripId} data={data} kind={section} reload={reload} />
				)
			) : null}
		</Screen>
	);
}

// --- Tasks and packing ------------------------------------------------------

function Tasks({
	tripId,
	data,
	kind,
	reload
}: {
	tripId: string;
	data: Data;
	kind: 'tasks' | 'packing';
	reload: () => void;
}) {
	const list = kind === 'packing' ? data.packing : data.tasks;
	const [editing, setEditing] = useState<Task | null>(null);
	const [adding, setAdding] = useState(false);

	// The box sends the state it wants rather than "flip", so two people ticking
	// the same row agree instead of cancelling each other out, and a double tap
	// on a slow connection is a no-op rather than an untick.
	const toggle = useMutation(
		(taskId: string, userId: string | undefined, done: boolean) =>
			api(`/trips/${tripId}/pretrip/tasks/${taskId}/toggle`, {
				method: 'POST',
				body: userId ? { userId, done } : { done }
			}),
		{ fallback: copy.preparation.saveFallback, onSuccess: reload }
	);

	// The web page splits tasks into the ones assigned to the reader and the
	// rest, and a task appears in exactly one of the two. Packing has no
	// assignment at all, so it stays a single list.
	const { mine, others } = useMemo(() => {
		if (kind === 'packing') return { mine: [] as Task[], others: list };
		const mine = list.filter((t) => t.people.some((p) => p.id === data.me));
		return { mine, others: list.filter((t) => !mine.includes(t)) };
	}, [list, kind, data.me]);

	const add = (
		<Pressable onPress={() => setAdding(true)} hitSlop={8}>
			<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
				{copy.preparation.add}
			</Text>
		</Pressable>
	);

	return (
		<>
			<FormError message={toggle.error} />

			{mine.length > 0 ? (
				<Card>
					<Head>{copy.preparation.myTasks.title}</Head>
					<View style={{ marginTop: space.sm }}>
						{mine.map((t) => (
							<TaskRow
								key={t.id}
								task={t}
								me={data.me}
								onToggle={(userId, done) => void toggle.run(t.id, userId, done)}
								onEdit={() => setEditing(t)}
							/>
						))}
					</View>
				</Card>
			) : null}

			<Card>
				<Head action={add}>
					{mine.length > 0 ? copy.preparation.myTasks.othersTitle : copy.preparation.sections[kind]}
				</Head>
				{others.length === 0 ? (
					<EmptyState message="Nothing added yet" />
				) : (
					<View style={{ marginTop: space.sm }}>
						{others.map((t) => (
							<TaskRow
								key={t.id}
								task={t}
								me={data.me}
								onToggle={(userId, done) => void toggle.run(t.id, userId, done)}
								onEdit={() => setEditing(t)}
							/>
						))}
					</View>
				)}
			</Card>

			<TaskSheet
				open={adding || editing !== null}
				tripId={tripId}
				kind={kind === 'packing' ? 'packing' : 'task'}
				members={data.members}
				task={editing}
				onClose={() => {
					setAdding(false);
					setEditing(null);
				}}
				onSaved={() => {
					setAdding(false);
					setEditing(null);
					reload();
				}}
			/>
		</>
	);
}

function TaskRow({
	task,
	me,
	onToggle,
	onEdit
}: {
	task: Task;
	me: string;
	onToggle: (userId: string | undefined, done: boolean) => void;
	onEdit: () => void;
}) {
	const mine = task.people.find((p) => p.id === me);

	return (
		<View style={{ paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: color.line }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
				<CheckBox
					checked={mine ? mine.done : task.done}
					label={copy.preparation.taskList.sharedBoxLabel(task.done, task.label)}
					onPress={() => onToggle(mine ? mine.id : undefined, !(mine ? mine.done : task.done))}
				/>
				<Pressable onPress={onEdit} style={{ flex: 1 }} hitSlop={6}>
					<Text
						style={{
							...type.body,
							color: task.done ? color.inkFaint : color.ink,
							textDecorationLine: task.done ? 'line-through' : 'none'
						}}
					>
						{task.label}
					</Text>
				</Pressable>
				{task.people.length > 0 ? (
					<Text style={type.faint}>
						{copy.preparation.taskList.doneSummary(task.doneCount, task.people.length)}
					</Text>
				) : null}
			</View>

			{task.people.length > 0 ? (
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
						<Pressable key={p.id} onPress={() => onToggle(p.id, !p.done)} hitSlop={4}>
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
		</View>
	);
}

// --- Estimated costs --------------------------------------------------------

function Costs({ tripId, data, reload }: { tripId: string; data: Data; reload: () => void }) {
	const [editing, setEditing] = useState<CostItem | null>(null);
	const [adding, setAdding] = useState(false);
	const [open, setOpen] = useState<Record<string, boolean>>({});

	const perPerson = data.memberCount > 0 ? data.budget.grandTotal / data.memberCount : 0;

	const byCategory = useMemo(() => {
		const groups = new Map<string, CostItem[]>();
		for (const cat of data.categories) groups.set(cat, []);
		for (const item of data.budget.items) {
			if (!groups.has(item.category)) groups.set(item.category, []);
			groups.get(item.category)!.push(item);
		}
		return [...groups.entries()];
	}, [data.budget.items, data.categories]);

	return (
		<>
			<Card>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
					<View style={{ flex: 1 }}>
						<Text style={type.faint}>{copy.preparation.tripTotal}</Text>
						<Text style={type.head}>{formatMoney(data.budget.grandTotal, data.currency)}</Text>
					</View>
					<View style={{ flex: 1 }}>
						<Text style={type.faint}>{copy.preparation.perPerson}</Text>
						<Text style={type.head}>{formatMoney(Math.round(perPerson), data.currency)}</Text>
					</View>
					<Pressable onPress={() => setAdding(true)} hitSlop={8}>
						<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
							{copy.preparation.add}
						</Text>
					</Pressable>
				</View>
			</Card>

			{byCategory.map(([category, items]) => {
				const subtotal = items.reduce((sum, it) => sum + it.homeCents, 0);
				const expanded = open[category] ?? items.length > 0;
				return (
					<Card key={category}>
						<Pressable
							onPress={() => setOpen((o) => ({ ...o, [category]: !expanded }))}
							style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
						>
							<Text style={{ ...type.faint, width: 14 }}>{expanded ? '▾' : '▸'}</Text>
							<Text style={{ ...type.body, fontWeight: '600', flex: 1 }}>{cap(category)}</Text>
							<Text style={type.small}>{formatMoney(subtotal, data.currency)}</Text>
						</Pressable>

						{expanded ? (
							items.length === 0 ? (
								<EmptyState message="Nothing added yet" />
							) : (
								items.map((it) => (
									<Pressable
										key={it.id}
										onPress={() => setEditing(it)}
										style={{
											flexDirection: 'row',
											alignItems: 'center',
											gap: space.md,
											paddingVertical: space.sm,
											borderTopWidth: 1,
											borderTopColor: color.line
										}}
									>
										<View style={{ flex: 1 }}>
											<Text style={type.body}>{it.label}</Text>
											{it.people.length > 0 ? (
												<Text style={type.faint}>{it.people.map((p) => p.name).join(', ')}</Text>
											) : (
												<Text style={type.faint}>{copy.preparation.costDialog.forEveryone}</Text>
											)}
										</View>
										<View style={{ alignItems: 'flex-end' }}>
											<Text style={type.small}>
												{formatMoney(it.amountCents, it.currency || data.currency)}
											</Text>
											{it.currency && it.currency !== data.currency ? (
												<Text style={type.faint}>≈ {formatMoney(it.homeCents, data.currency)}</Text>
											) : null}
										</View>
									</Pressable>
								))
							)
						) : null}
					</Card>
				);
			})}

			<CostSheet
				open={adding || editing !== null}
				tripId={tripId}
				currency={data.currency}
				categories={data.categories}
				members={data.members}
				item={editing}
				onClose={() => {
					setAdding(false);
					setEditing(null);
				}}
				onSaved={() => {
					setAdding(false);
					setEditing(null);
					reload();
				}}
			/>
		</>
	);
}
