import { useState } from 'react';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { useTrip } from './TripShell';
import Modal from '../components/Modal';
import Select from '../components/Select';
import SectionNav from '../components/SectionNav';

type Person = { id: string; name: string; done: boolean };
type Task = {
	id: string;
	label: string;
	flag: string | null;
	people: Person[];
	shared: boolean;
	done: boolean;
	doneCount: number;
};
type CostItem = {
	id: string;
	label: string;
	category: string;
	cityId: string | null;
	cityName: string | null;
	amountCents: number;
};
type Data = {
	me: string;
	members: { id: string; name: string }[];
	tasks: Task[];
	packing: Task[];
	currency: string;
	memberCount: number;
	categories: string[];
	cities: { id: string; name: string }[];
	budget: {
		items: CostItem[];
		categoryTotals: Record<string, number>;
		grandTotal: number;
	};
};

type Draft = {
	id: string | null;
	label: string;
	amount: string;
	category: string;
	cityId: string;
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function Pretrip() {
	const { trip } = useTrip();
	const { data, error, reload } = useApi<Data>(`/trips/${trip.id}/pretrip`);
	const [section, setSection] = useState('tasks');
	const [adding, setAdding] = useState<'task' | 'packing' | null>(null);
	/** Add and edit share one modal; `id` is null when adding. */
	const [editing, setEditing] = useState<Draft | null>(null);
	const [notice, setNotice] = useState('');

	if (!data) return error ? <p className="text-warn">{error}</p> : null;

	const doneCount = data.tasks.filter((t) => t.done).length;
	const packedCount = data.packing.filter((t) => t.done).length;

	/** Badges count what is still outstanding: the number you act on. */
	const sections = [
		{
			id: 'tasks',
			label: 'Tasks',
			badge: data.tasks.length - doneCount || null
		},
		{
			id: 'packing',
			label: 'Packing',
			badge: data.packing.length - packedCount || null
		},
		{ id: 'costs', label: 'Estimated costs', badge: null }
	];

	const fmt = (cents: number) =>
		new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: data.currency,
			maximumFractionDigits: 0
		}).format(cents / 100);

	const grand = data.budget.grandTotal;
	const perPerson = data.memberCount ? grand / data.memberCount : grand;

	async function act(fn: () => Promise<unknown>) {
		setNotice('');
		try {
			await fn();
			reload();
		} catch (err) {
			setNotice(err instanceof ApiError ? err.message : 'Something went wrong.');
		}
	}

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<SectionNav
				items={sections}
				value={section}
				onChange={setSection}
				ariaLabel="Preparation sections"
			/>

			<div className="min-w-0">
				{notice && (
					<p
						role="alert"
						className="mb-4 rounded-sm bg-danger-soft px-3.5 py-2.5 text-[0.9rem] text-danger-ink"
					>
						{notice}
					</p>
				)}

				{/* The row keeps its height across sections, so switching never shifts
				    the card below it up or down. */}
				<div className="mb-4 flex min-h-phead flex-wrap items-center justify-end gap-4">
					{section === 'tasks' && (
						<button className="btn primary" onClick={() => setAdding('task')}>
							+ Add task
						</button>
					)}
					{section === 'packing' && (
						<button className="btn primary" onClick={() => setAdding('packing')}>
							+ Add item
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
							+ Add cost
						</button>
					)}
				</div>

				{section !== 'costs' ? (
					<div className="card min-w-0 px-5 py-5">
						<TaskList
							items={section === 'tasks' ? data.tasks : data.packing}
							kind={section === 'tasks' ? 'task' : 'packing'}
							me={data.me}
							empty={section === 'tasks' ? 'No tasks yet.' : 'Nothing packed yet.'}
							onToggle={(taskId, userId) =>
								act(() =>
									api(`/trips/${trip.id}/pretrip/tasks/${taskId}/toggle`, {
										method: 'POST',
										body: userId ? { userId } : {}
									})
								)
							}
							onRemove={(taskId) =>
								act(() =>
									api(`/trips/${trip.id}/pretrip/tasks/${taskId}`, {
										method: 'DELETE'
									})
								)
							}
						/>
					</div>
				) : (
					<>
						<div className="mb-4 flex min-w-0 flex-wrap items-end gap-6">
							<Stat label="Trip total" value={fmt(grand)} />
							<Stat label="Per person" value={fmt(perPerson)} />
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
							onRemove={(id) =>
								act(() =>
									api(`/trips/${trip.id}/pretrip/costs/${id}`, {
										method: 'DELETE'
									})
								)
							}
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

function TaskList({
	items,
	kind,
	me,
	empty,
	onToggle,
	onRemove
}: {
	items: Task[];
	kind: 'task' | 'packing';
	me: string;
	empty: string;
	onToggle: (taskId: string, userId?: string) => void;
	onRemove: (taskId: string) => void;
}) {
	/** Which task's roster is expanded. Only one at a time, because these lists are long. */
	const [openRoster, setOpenRoster] = useState<string | null>(null);

	if (items.length === 0) {
		return <p className="m-0 px-1.5 py-2 text-[0.9rem] text-ink-faint">{empty}</p>;
	}

	return (
		<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
			{items.map((it) => {
				const mine = it.people.find((p) => p.id === me) ?? null;
				return (
					<li key={it.id}>
						{/* `group` so the delete button can stay hidden until the row is
						    hovered without a hover-only stylesheet rule. */}
						<div className="group flex min-w-0 items-center gap-2.5 rounded-[10px] px-1.5 py-2 text-[0.94rem] hover:bg-surface-2">
							{it.people.length === 0 ? (
								<Box
									on={it.shared}
									label={`${it.shared ? 'Mark not done' : 'Mark done'}: ${it.label}`}
									onClick={() => onToggle(it.id)}
								/>
							) : mine ? (
								<Box
									on={mine.done}
									label={`${mine.done ? 'Mark not done for you' : 'Mark done for you'}: ${it.label}`}
									onClick={() => onToggle(it.id)}
								/>
							) : (
								<span
									title="Assigned to other people"
									aria-label={`${it.label} is not assigned to you`}
									className="size-[18px] flex-none rounded-[5px] border border-dashed border-line bg-surface-2"
								/>
							)}

							<span
								className={`min-w-0 flex-1 truncate ${it.done ? 'text-ink-faint line-through' : ''}`}
								title={it.label}
							>
								{it.label}
							</span>

							{it.flag && <span className="chip flex-none border-warn text-warn">{it.flag}</span>}

							{it.people.length > 0 && (
								<div className="flex min-w-0 flex-none items-center gap-1.5">
									{it.people.length === 1 ? (
										<span
											className="max-w-36 truncate text-[0.74rem] text-ink-soft"
											title={it.people[0].name}
										>
											{it.people[0].name}
										</span>
									) : (
										/* The bar carries the at-a-glance signal, the count is the
										   accessible text, and the whole thing expands the roster. */
										<button
											type="button"
											aria-expanded={openRoster === it.id}
											title="Who still has to do this"
											onClick={() => setOpenRoster((v) => (v === it.id ? null : it.id))}
											className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pr-2 pl-1.5 text-[0.74rem] text-ink-soft hover:border-accent"
										>
											<span className="block h-1 w-[34px] flex-none overflow-hidden rounded-full bg-line">
												<span
													className="block h-full bg-accent"
													style={{
														width: `${(it.doneCount / it.people.length) * 100}%`
													}}
												/>
											</span>
											<span className="tabular-nums whitespace-nowrap">
												{it.doneCount}/{it.people.length}
											</span>
										</button>
									)}
									{mine && (
										<span
											className={`flex-none rounded-full px-2 py-0.5 text-[0.72rem] whitespace-nowrap ${
												mine.done ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-ink-faint'
											}`}
										>
											{mine.done ? 'You: done' : 'You: to do'}
										</span>
									)}
								</div>
							)}

							<button
								type="button"
								onClick={() => onRemove(it.id)}
								aria-label={`Remove ${kind}: ${it.label}`}
								className="flex-none cursor-pointer border-none bg-transparent px-1 text-[1.05rem] leading-none text-ink-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger-ink"
							>
								×
							</button>
						</div>

						{openRoster === it.id && (
							<ul className="flex list-none flex-row flex-wrap gap-1.5 pt-0.5 pr-1.5 pb-2.5 pl-8">
								{it.people.map((p) => {
									const isMe = p.id === me;
									const cls = [
										'inline-flex max-w-44 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.76rem]',
										p.done
											? 'border-transparent bg-accent-soft text-accent-ink'
											: 'border-line bg-surface text-ink-soft',
										isMe ? 'cursor-pointer' : 'cursor-default'
									].join(' ');
									const inner = (
										<>
											<span
												className={`grid size-3 flex-none place-items-center rounded-[4px] border border-current text-[0.6rem] ${p.done ? '' : 'opacity-70'}`}
											>
												{p.done ? '✓' : ''}
											</span>
											<span className="min-w-0 truncate" title={p.name}>
												{p.name}
												{isMe ? ' (you)' : ''}
											</span>
										</>
									);
									return (
										<li key={p.id} className="min-w-0">
											{isMe ? (
												<button
													type="button"
													className={cls}
													onClick={() => onToggle(it.id)}
													aria-label={`${p.done ? 'Mark not done' : 'Mark done'} for you: ${it.label}`}
												>
													{inner}
												</button>
											) : (
												<span className={cls}>{inner}</span>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function Box({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			className={`grid size-[18px] flex-none cursor-pointer place-items-center rounded-[5px] border p-0 text-[0.72rem] text-white ${
				on ? 'border-accent bg-accent' : 'border-line bg-surface'
			}`}
		>
			{on ? '✓' : ''}
		</button>
	);
}

function CostTable({
	items,
	total,
	fmt,
	onEdit,
	onRemove
}: {
	items: CostItem[];
	total: number;
	fmt: (cents: number) => string;
	onEdit: (it: CostItem) => void;
	onRemove: (id: string) => void;
}) {
	const CELL = 'border-b border-line px-4 py-2.5 text-left text-[0.92rem]';
	const TH =
		'border-b border-line px-4 py-2.5 text-left text-[0.72rem] font-medium tracking-[0.06em] text-ink-faint uppercase';

	return (
		<div className="card overflow-hidden p-0">
			<table className="w-full table-fixed border-collapse">
				<thead>
					<tr>
						<th className={TH}>Item</th>
						<th className={`${TH} w-[22%]`}>Category</th>
						<th className={`${TH} w-[18%]`}>City</th>
						<th className={`${TH} w-[16%] text-right`}>Amount</th>
						<th className={`${TH} w-22`} />
					</tr>
				</thead>
				<tbody>
					{items.map((it) => (
						<tr key={it.id} className="hover:bg-surface-2">
							<td className={`${CELL} truncate`} title={it.label}>
								{it.label}
							</td>
							<td className={CELL}>
								<span className="chip text-[0.74rem]">{cap(it.category)}</span>
							</td>
							<td className={`${CELL} muted truncate`} title={it.cityName ?? 'General'}>
								{it.cityName ?? 'General'}
							</td>
							<td className={`${CELL} text-right font-semibold tabular-nums`}>
								{fmt(it.amountCents)}
							</td>
							<td className={`${CELL} text-right`}>
								<IconBtn label={`Edit ${it.label}`} onClick={() => onEdit(it)}>
									✎
								</IconBtn>
								<IconBtn label={`Remove ${it.label}`} onClick={() => onRemove(it.id)}>
									✕
								</IconBtn>
							</td>
						</tr>
					))}
					{items.length === 0 && (
						<tr>
							<td colSpan={5} className={`${CELL} muted`}>
								No costs yet. Add your first estimate above.
							</td>
						</tr>
					)}
				</tbody>
				<tfoot>
					<tr className="bg-surface-2 font-medium">
						<td colSpan={3} className="px-4 py-2.5 text-[0.92rem]">
							Total
						</td>
						<td className="px-4 py-2.5 text-right text-[0.92rem] font-semibold tabular-nums">
							{fmt(total)}
						</td>
						<td />
					</tr>
				</tfoot>
			</table>
		</div>
	);
}

function IconBtn({
	label,
	onClick,
	children
}: {
	label: string;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className="cursor-pointer border-none bg-transparent px-1 text-[0.9rem] text-ink-faint hover:text-accent-ink"
		>
			{children}
		</button>
	);
}

function AddTask({
	kind,
	members,
	me,
	tripId,
	onClose,
	onSaved
}: {
	kind: 'task' | 'packing';
	members: { id: string; name: string }[];
	me: string;
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState('');
	const [assignees, setAssignees] = useState<Set<string>>(new Set());
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError('');
		try {
			await api(`/trips/${tripId}/pretrip/tasks`, {
				method: 'POST',
				body: { kind, label, assignees: [...assignees] }
			});
			onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof ApiError ? err.message : 'Could not add that.');
			setSaving(false);
		}
	}

	return (
		<Modal
			open
			size="sm"
			title={kind === 'task' ? 'Add a task' : 'Add a packing item'}
			onClose={onClose}
		>
			<form className="mform" onSubmit={submit}>
				<div className="mbody flex flex-col gap-3">
					<label className="field">
						<span>What needs doing?</span>
						<input
							autoFocus
							required
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							className="input w-full"
						/>
					</label>

					<fieldset className="m-0 min-w-0 rounded-[10px] border border-line px-3 py-3">
						<legend className="px-1 text-[0.8rem] text-ink-soft">Who has to do it?</legend>
						<p className="muted m-0 mb-2 text-[0.78rem] text-pretty">
							Pick more than one and each person ticks their own box, so the task is not done until
							everyone is. Leave empty for a one-off the group only needs once.
						</p>
						<div className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(min(9rem,100%),1fr))] gap-0.5 overflow-y-auto overscroll-contain">
							{members.map((m) => (
								<label
									key={m.id}
									className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-[0.85rem] text-ink hover:bg-surface-2"
								>
									<input
										type="checkbox"
										checked={assignees.has(m.id)}
										onChange={() =>
											setAssignees((prev) => {
												const next = new Set(prev);
												if (next.has(m.id)) next.delete(m.id);
												else next.add(m.id);
												return next;
											})
										}
										className="flex-none accent-accent"
									/>
									<span className="min-w-0 truncate">
										{m.name}
										{m.id === me ? ' (you)' : ''}
									</span>
								</label>
							))}
							{members.length === 0 && <p className="muted text-[0.9rem]">No members yet.</p>}
						</div>
						{members.length > 2 && (
							<div className="flex gap-3 px-1 pt-2">
								<LinkBtn onClick={() => setAssignees(new Set(members.map((m) => m.id)))}>
									Select everyone
								</LinkBtn>
								<LinkBtn onClick={() => setAssignees(new Set())}>Clear</LinkBtn>
							</div>
						)}
					</fieldset>
				</div>

				<div className="mfoot">
					{error && (
						<p role="alert" className="mfoot-note m-0 text-[0.86rem] text-danger-ink">
							{error}
						</p>
					)}
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={saving}>
						{saving ? 'Adding...' : 'Add'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function EditCost({
	draft,
	currency,
	categories,
	cities,
	tripId,
	onClose,
	onSaved
}: {
	draft: Draft;
	currency: string;
	categories: string[];
	cities: { id: string; name: string }[];
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState(draft.label);
	const [amount, setAmount] = useState(draft.amount);
	const [category, setCategory] = useState(draft.category);
	const [cityId, setCityId] = useState(draft.cityId);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError('');
		try {
			await api(
				draft.id ? `/trips/${tripId}/pretrip/costs/${draft.id}` : `/trips/${tripId}/pretrip/costs`,
				{
					method: draft.id ? 'PUT' : 'POST',
					body: { label, amount: Number(amount), category, cityId }
				}
			);
			onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof ApiError ? err.message : 'Could not save that item.');
			setSaving(false);
		}
	}

	return (
		<Modal open size="sm" title={draft.id ? 'Edit cost' : 'Add cost'} onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody flex flex-col gap-3">
					<label className="field">
						<span>What is it?</span>
						<input
							autoFocus
							required
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							className="input w-full"
						/>
					</label>
					<div className="flex flex-wrap gap-2.5">
						<label className="field flex-[0_1_130px]">
							<span>Amount ({currency})</span>
							<input
								type="number"
								min="0"
								step="1"
								required
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								className="input w-full"
							/>
						</label>
						<label className="field flex-[1_1_130px]">
							<span>Category</span>
							<Select
								options={categories.map((c) => ({ value: c, label: cap(c) }))}
								value={category}
								onChange={setCategory}
								ariaLabel="Category"
							/>
						</label>
						<label className="field flex-[1_1_130px]">
							<span>City</span>
							<Select
								options={[
									{ value: '', label: 'All / general' },
									...cities.map((c) => ({ value: c.id, label: c.name }))
								]}
								value={cityId}
								onChange={setCityId}
								ariaLabel="City"
							/>
						</label>
					</div>
				</div>

				<div className="mfoot">
					{error && (
						<p role="alert" className="mfoot-note m-0 text-[0.86rem] text-danger-ink">
							{error}
						</p>
					)}
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={saving}>
						{saving ? 'Saving...' : draft.id ? 'Save changes' : 'Add cost'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function LinkBtn({ onClick, children }: { onClick: () => void; children: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="cursor-pointer border-none bg-transparent p-0 text-[0.78rem] text-accent underline"
		>
			{children}
		</button>
	);
}
