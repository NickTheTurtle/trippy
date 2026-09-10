import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { useMutation } from '../hooks/useMutation';
import { formatMoney } from '../lib/format';
import { useTrip } from './TripShell';
import SectionNav from '../components/ui/SectionNav';
import FormError from '../components/ui/FormError';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import type { Task, CostItem, PretripData, Draft, TaskDraft } from './pretrip/types';
import TaskList, { ListTitle } from './pretrip/TaskList';
import MyTasks, { isMine } from './pretrip/MyTasks';
import CostList, { nameOf } from './pretrip/CostList';
import EditTask from './pretrip/EditTask';
import EditCost from './pretrip/EditCost';
import { totalFor } from './pretrip/shares';
import { copy } from '../copy';

const cp = copy.preparation;

/**
 * Preparation: the tasks, the packing list and the cost estimates.
 *
 * This file is composition only. The two lists, the estimates table and the
 * two dialogs live in `pages/pretrip/`.
 */
export default function Pretrip() {
	const { trip } = useTrip();
	const { data, error, reload } = useApi<PretripData>(`/trips/${trip.id}/pretrip`);
	// One payload holds the tasks, the packing list and the cost estimates, and
	// the per-person figure depends on the roster.
	useLiveSection(['tasks', 'costs', 'members', 'trip'], reload);
	const [section, setSection] = useState('tasks');
	/** Add and edit share one modal; `id` is null when adding. */
	const [editingTask, setEditingTask] = useState<TaskDraft | null>(null);
	const [editing, setEditing] = useState<Draft | null>(null);
	/** The row a confirmation is open for, and which list it came from. */
	const [pendingTask, setPendingTask] = useState<{ kind: 'task' | 'packing'; task: Task } | null>(
		null
	);
	const [pendingCost, setPendingCost] = useState<CostItem | null>(null);
	/** Whose money the estimates are read as. '' is the whole trip. */
	const [viewAs, setViewAs] = useState('');

	// One state machine for the small in-place writes this page makes (ticking a
	// box, and the deletes the dialogs below confirm), so a refusal lands in the
	// banner instead of being thrown into nothing.
	const act = useMutation<[() => Promise<unknown>]>((fn) => fn(), {
		onSuccess: reload,
		fallback: cp.saveFallback
	});

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	const doneCount = data.tasks.filter((t) => t.done).length;
	const packedCount = data.packing.filter((t) => t.done).length;

	/** Badges count what is still outstanding: the number you act on. */
	const sections = [
		{
			id: 'tasks',
			label: cp.sections.tasks,
			badge: data.tasks.length - doneCount || null
		},
		{
			id: 'packing',
			label: cp.sections.packing,
			badge: data.packing.length - packedCount || null
		},
		{ id: 'costs', label: cp.sections.costs, badge: null }
	];

	// Whole units: these are estimates, and the cents on a guessed number are
	// noise. The rounding is the formatter's, not a second division here.
	const fmt = (cents: number) => formatMoney(cents, data.currency, { whole: true });

	const grand = data.budget.grandTotal;
	const perPerson = data.memberCount ? grand / data.memberCount : grand;
	// Reading the estimates as one person answers "what does this cost me", so
	// the second stat stops being the average and becomes their own share of
	// every line they are on. The trip total beside it stays whole, as the thing
	// being divided.
	const shownTotal = totalFor(data.budget.items, viewAs, data.memberCount);

	// Both task lists take the same handlers; they differ only in which rows
	// they hold and whose box each row leads with.
	const taskProps = {
		kind: section === 'tasks' ? ('task' as const) : ('packing' as const),
		me: data.me,
		onToggle: (taskId: string) =>
			void act.run(() =>
				api(`/trips/${trip.id}/pretrip/tasks/${taskId}/toggle`, { method: 'POST', body: {} })
			),
		// The API ticks one box at a time, so a change to the menu walks the
		// roster. Only the people whose state actually changed are touched, and it
		// runs inside one mutation so a refusal halts the rest instead of leaving
		// the row half ticked.
		onSetDone: (task: Task, doneIds: string[]) =>
			void act.run(async () => {
				for (const p of task.people) {
					if (p.done === doneIds.includes(p.id)) continue;
					await api(`/trips/${trip.id}/pretrip/tasks/${task.id}/toggle`, {
						method: 'POST',
						body: { userId: p.id }
					});
				}
			}),
		onEdit: (task: Task) =>
			setEditingTask({
				id: task.id,
				kind: section === 'tasks' ? 'task' : 'packing',
				label: task.label,
				assignees: task.people.map((p) => p.id)
			}),
		onRemove: (task: Task) =>
			setPendingTask({ kind: section === 'tasks' ? 'task' : 'packing', task })
	};

	// Your own rows move out of the list rather than being copied out of it, so
	// the list below is titled only while something has been lifted from it.
	const rest = section === 'tasks' ? data.tasks.filter((t) => !isMine(t, data.me)) : data.packing;
	const split = section === 'tasks' && rest.length < data.tasks.length;

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<SectionNav
				items={sections}
				value={section}
				onChange={setSection}
				ariaLabel={cp.navAriaLabel}
			/>

			<div className="min-w-0">
				<FormError message={act.error} variant="banner" />

				{/* The row keeps its height across sections, so switching never shifts
				    the card below it up or down. The section is named by the nav to the
				    left, so the button only has to say what it does. The estimates put
				    their two figures on this line: they answer the question the tab is
				    open for, and a band of their own above the table only pushed the
				    numbers further from the rows they add up. */}
				<div className="mb-4 flex min-h-phead flex-wrap items-center justify-between gap-4">
					<div className="flex min-w-0 flex-wrap items-end gap-6">
						{section === 'costs' && (
							<>
								<Stat label={cp.tripTotal} value={fmt(grand)} />
								<Stat
									label={viewAs ? cp.costTable.share(nameOf(data.members, viewAs)) : cp.perPerson}
									value={fmt(viewAs ? shownTotal : perPerson)}
								/>
							</>
						)}
					</div>
					<button
						className="btn primary"
						onClick={() =>
							section === 'costs'
								? setEditing({
										id: null,
										label: '',
										amount: '',
										category: data.categories[0] ?? '',
										assignees: []
									})
								: setEditingTask({
										id: null,
										kind: section === 'tasks' ? 'task' : 'packing',
										label: '',
										assignees: []
									})
						}
					>
						{cp.add}
					</button>
				</div>

				{section !== 'costs' ? (
					<>
						{section === 'tasks' && <MyTasks {...taskProps} items={data.tasks} />}
						{(rest.length > 0 || !split) && (
							<div className="card min-w-0 px-5 py-5">
								{split && <ListTitle>{cp.myTasks.othersTitle}</ListTitle>}
								<TaskList {...taskProps} items={rest} />
							</div>
						)}
					</>
				) : (
					<CostList
						items={data.budget.items}
						categories={data.categories}
						members={data.members}
						me={data.me}
						memberCount={data.memberCount}
						viewAs={viewAs}
						onViewAs={setViewAs}
						total={shownTotal}
						fmt={fmt}
						onEdit={(it) =>
							setEditing({
								id: it.id,
								label: it.label,
								amount: String(it.amountCents / 100),
								category: it.category,
								assignees: it.people.map((p) => p.id)
							})
						}
						onRemove={(it) => setPendingCost(it)}
					/>
				)}
			</div>

			{editingTask && (
				<EditTask
					draft={editingTask}
					members={data.members}
					me={data.me}
					tripId={trip.id}
					onClose={() => setEditingTask(null)}
					onSaved={reload}
				/>
			)}

			{editing && (
				<EditCost
					draft={editing}
					currency={data.currency}
					categories={data.categories}
					members={data.members}
					me={data.me}
					tripId={trip.id}
					onClose={() => setEditing(null)}
					onSaved={reload}
				/>
			)}

			{/* Deleting a task takes the whole row, including everyone else's ticks
			    on it. */}
			<ConfirmDialog
				open={!!pendingTask}
				title={
					pendingTask
						? pendingTask.kind === 'packing'
							? cp.deleteTask.packingTitle(pendingTask.task.label)
							: cp.deleteTask.taskTitle(pendingTask.task.label)
						: ''
				}
				busyLabel={copy.common.deleting}
				onCancel={() => setPendingTask(null)}
				onConfirm={async () => {
					if (!pendingTask) return;
					await api(`/trips/${trip.id}/pretrip/tasks/${pendingTask.task.id}`, {
						method: 'DELETE'
					});
					setPendingTask(null);
					reload();
				}}
			/>

			<ConfirmDialog
				open={!!pendingCost}
				title={pendingCost ? cp.deleteCost.title(pendingCost.label) : ''}
				busyLabel={copy.common.deleting}
				onCancel={() => setPendingCost(null)}
				onConfirm={async () => {
					if (!pendingCost) return;
					await api(`/trips/${trip.id}/pretrip/costs/${pendingCost.id}`, { method: 'DELETE' });
					setPendingCost(null);
					reload();
				}}
			/>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col">
			<span className="muted text-[0.8rem]">{label}</span>
			<strong className="font-serif text-2xl">{value}</strong>
		</div>
	);
}
