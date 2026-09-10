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
import type { Task, CostItem, PretripData, Draft } from './pretrip/types';
import { cap } from './pretrip/labels';
import TaskList from './pretrip/TaskList';
import CostTable from './pretrip/CostTable';
import AddTask from './pretrip/AddTask';
import EditCost from './pretrip/EditCost';
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
	const [adding, setAdding] = useState<'task' | 'packing' | null>(null);
	/** Add and edit share one modal; `id` is null when adding. */
	const [editing, setEditing] = useState<Draft | null>(null);
	/** The row a confirmation is open for, and which list it came from. */
	const [pendingTask, setPendingTask] = useState<{ kind: 'task' | 'packing'; task: Task } | null>(
		null
	);
	const [pendingCost, setPendingCost] = useState<CostItem | null>(null);

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
				    the card below it up or down. */}
				<div className="mb-4 flex min-h-phead flex-wrap items-center justify-end gap-4">
					{section === 'tasks' && (
						<button className="btn primary" onClick={() => setAdding('task')}>
							{cp.addTask}
						</button>
					)}
					{section === 'packing' && (
						<button className="btn primary" onClick={() => setAdding('packing')}>
							{cp.addPackingItem}
						</button>
					)}
					{section === 'costs' && (
						<button
							className="btn primary"
							onClick={() =>
								setEditing({
									id: null,
									label: '',
									amount: '',
									category: data.categories[0] ?? '',
									cityId: ''
								})
							}
						>
							{cp.addCost}
						</button>
					)}
				</div>

				{section !== 'costs' ? (
					<div className="card min-w-0 px-5 py-5">
						<TaskList
							items={section === 'tasks' ? data.tasks : data.packing}
							kind={section === 'tasks' ? 'task' : 'packing'}
							me={data.me}
							onToggle={(taskId, userId) =>
								void act.run(() =>
									api(`/trips/${trip.id}/pretrip/tasks/${taskId}/toggle`, {
										method: 'POST',
										body: userId ? { userId } : {}
									})
								)
							}
							onRemove={(task) =>
								setPendingTask({
									kind: section === 'tasks' ? 'task' : 'packing',
									task
								})
							}
						/>
					</div>
				) : (
					<>
						<div className="mb-4 flex min-w-0 flex-wrap items-end gap-6">
							<Stat label={cp.tripTotal} value={fmt(grand)} />
							<Stat label={cp.perPerson} value={fmt(perPerson)} />
						</div>

						<div className="mb-4 flex flex-wrap gap-2.5">
							{data.categories.map((c) => (
								<div
									key={c}
									className="flex min-w-0 items-baseline gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5"
								>
									<span className="muted text-[0.78rem]">{cap(c)}</span>
									<strong className="text-[0.9rem]">
										{fmt(data.budget.categoryTotals[c] ?? 0)}
									</strong>
								</div>
							))}
						</div>

						<CostTable
							items={data.budget.items}
							total={grand}
							fmt={fmt}
							onEdit={(it) =>
								setEditing({
									id: it.id,
									label: it.label,
									amount: String(it.amountCents / 100),
									category: it.category,
									cityId: it.cityId ?? ''
								})
							}
							onRemove={(it) => setPendingCost(it)}
						/>
					</>
				)}
			</div>

			{adding && (
				<AddTask
					kind={adding}
					members={data.members}
					me={data.me}
					tripId={trip.id}
					onClose={() => setAdding(null)}
					onSaved={reload}
				/>
			)}

			{editing && (
				<EditCost
					draft={editing}
					currency={data.currency}
					categories={data.categories}
					cities={data.cities}
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
