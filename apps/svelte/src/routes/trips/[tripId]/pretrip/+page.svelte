<script lang="ts">
	import { enhance } from '$app/forms';
	import Select from '$lib/components/Select.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import SectionNav from '$lib/components/SectionNav.svelte';
	import { focusOnMount } from '$lib/focus';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Task = PageData['tasks'][number];

	const doneCount = $derived(data.tasks.filter((t) => t.done).length);
	const packedCount = $derived(data.packing.filter((t) => t.done).length);

	let section = $state('tasks');
	/** Badges count what is still outstanding: the number you act on. */
	const sections = $derived([
		{ id: 'tasks', label: 'Tasks', badge: data.tasks.length - doneCount || null },
		{ id: 'packing', label: 'Packing', badge: data.packing.length - packedCount || null },
		{ id: 'costs', label: 'Estimated costs', badge: null }
	]);

	/** Which task's roster is expanded. Only one at a time, because these lists are long. */
	let openRoster = $state<string | null>(null);

	function myShare(t: Task) {
		return t.people.find((p) => p.id === data.me) ?? null;
	}

	interface CostItem {
		id: string;
		label: string;
		category: string;
		cityId: string | null;
		amountCents: number;
	}

	/** Add and edit share one modal; `id` is null when adding. */
	let editing = $state<{
		id: string | null;
		label: string;
		amount: string;
		category: string;
		cityId: string;
	} | null>(null);

	let adding = $state<'task' | 'packing' | null>(null);
	let wholistEl = $state<HTMLDivElement | null>(null);

	function setAllAssignees(on: boolean): void {
		wholistEl
			?.querySelectorAll<HTMLInputElement>('input[name="assignee"]')
			.forEach((el) => (el.checked = on));
	}

	const catOptions = $derived(
		data.categories.map((c: string) => ({
			value: c,
			label: c[0].toUpperCase() + c.slice(1)
		}))
	);
	const cityOptions = $derived([
		{ value: '', label: 'All / general' },
		...data.cities.map((c) => ({ value: c.id, label: c.name }))
	]);

	function beginAdd() {
		editing = { id: null, label: '', amount: '', category: data.categories[0] ?? '', cityId: '' };
	}
	function beginEdit(it: CostItem) {
		editing = {
			id: it.id,
			label: it.label,
			amount: String(it.amountCents / 100),
			category: it.category,
			cityId: it.cityId ?? ''
		};
	}

	function fmt(cents: number): string {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: data.currency,
			maximumFractionDigits: 0
		}).format(cents / 100);
	}
	const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
	const grand = $derived(data.budget.grandTotal);
	const perPerson = $derived(data.memberCount ? grand / data.memberCount : grand);
</script>

{#snippet roster(t: Task)}
	{@const mine = myShare(t)}
	<div class="rosterrow">
		{#if t.people.length === 1}
			<span class="solo" title={t.people[0].name}>{t.people[0].name}</span>
		{:else}
			<button
				type="button"
				class="prog"
				aria-expanded={openRoster === t.id}
				onclick={() => (openRoster = openRoster === t.id ? null : t.id)}
				title="Who still has to do this"
			>
				<span class="bar"
					><span style={`width:${(t.doneCount / t.people.length) * 100}%`}></span></span
				>
				<span class="pcount">{t.doneCount}/{t.people.length}</span>
			</button>
		{/if}
		{#if mine}
			<span class="youtag" class:on={mine.done}>{mine.done ? 'You: done' : 'You: to do'}</span>
		{/if}
	</div>
{/snippet}

{#snippet taskList(items: Task[], kind: 'task' | 'packing', empty: string)}
	<ul>
		{#each items as it (it.id)}
			{@const mine = myShare(it)}
			<li class:done={it.done}>
				<div class="row">
					{#if it.people.length === 0}
						<form method="POST" action="?/toggle" use:enhance class="chk">
							<input type="hidden" name="id" value={it.id} />
							<button
								class="box"
								class:on={it.shared}
								type="submit"
								aria-label={`${it.shared ? 'Mark not done' : 'Mark done'}: ${it.label}`}
								>{it.shared ? '✓' : ''}</button
							>
						</form>
					{:else if mine}
						<form method="POST" action="?/toggle" use:enhance class="chk">
							<input type="hidden" name="id" value={it.id} />
							<button
								class="box"
								class:on={mine.done}
								type="submit"
								aria-label={`${mine.done ? 'Mark not done for you' : 'Mark done for you'}: ${it.label}`}
								>{mine.done ? '✓' : ''}</button
							>
						</form>
					{:else}
						<span
							class="box other"
							title="Assigned to other people"
							aria-label={`${it.label} is not assigned to you`}
						></span>
					{/if}

					<span class="lbl" title={it.label}>{it.label}</span>
					{#if it.flag}<span class="chip warn">{it.flag}</span>{/if}
					{#if it.people.length > 0}
						{@render roster(it)}
					{/if}

					<form method="POST" action="?/remove" use:enhance class="delf">
						<input type="hidden" name="id" value={it.id} />
						<button class="del" aria-label={`Remove ${kind}: ${it.label}`}>×</button>
					</form>
				</div>

				{#if openRoster === it.id}
					<ul class="people">
						{#each it.people as p (p.id)}
							<li class="person">
								{#if p.id === data.me}
									<form method="POST" action="?/toggle" use:enhance>
										<input type="hidden" name="id" value={it.id} />
										<button
											type="submit"
											class="pchip"
											class:on={p.done}
											aria-label={`${p.done ? 'Mark not done' : 'Mark done'} for you: ${it.label}`}
										>
											<span class="tick">{p.done ? '✓' : ''}</span>
											<span class="pname">{p.name} (you)</span>
										</button>
									</form>
								{:else}
									<span class="pchip static" class:on={p.done}>
										<span class="tick">{p.done ? '✓' : ''}</span>
										<span class="pname" title={p.name}>{p.name}</span>
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
		{#if items.length === 0}
			<li class="muted empty">{empty}</li>
		{/if}
	</ul>
{/snippet}

<div class="layout">
	<SectionNav items={sections} bind:value={section} ariaLabel="Preparation sections" />

	<div class="panel">
		{#if form?.error}
			<p class="note error" role="alert">{form.error}</p>
		{/if}

		{#if section === 'tasks'}
			<div class="phead">
				<button type="button" class="btn primary" onclick={() => (adding = 'task')}
					>+ Add task</button
				>
			</div>
			<div class="card block">
				{@render taskList(data.tasks, 'task', 'No tasks yet.')}
			</div>
		{:else if section === 'packing'}
			<div class="phead">
				<button type="button" class="btn primary" onclick={() => (adding = 'packing')}
					>+ Add item</button
				>
			</div>
			<div class="card block">
				{@render taskList(data.packing, 'packing', 'Nothing packed yet.')}
			</div>
		{:else}
			<div class="phead">
				<button type="button" class="btn primary" onclick={beginAdd}>+ Add cost</button>
			</div>

			<div class="summary">
				<div class="stat">
					<span class="muted">Trip total</span>
					<strong>{fmt(grand)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Per person</span>
					<strong>{fmt(perPerson)}</strong>
				</div>
			</div>

			<div class="cats">
				{#each data.categories as cat}
					<div class="catchip">
						<span class="muted">{cap(cat)}</span>
						<strong>{fmt(data.budget.categoryTotals[cat] ?? 0)}</strong>
					</div>
				{/each}
			</div>

			<div class="card table">
				<table>
					<thead>
						<tr>
							<th>Item</th>
							<th>Category</th>
							<th>City</th>
							<th class="r">Amount</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.budget.items as it (it.id)}
							<tr>
								<td class="cell" title={it.label}>{it.label}</td>
								<td><span class="pill">{cap(it.category)}</span></td>
								<td class="muted cell" title={it.cityName ?? 'General'}
									>{it.cityName ?? 'General'}</td
								>
								<td class="r strong">{fmt(it.amountCents)}</td>
								<td class="r acts">
									<button
										type="button"
										class="iconbtn"
										onclick={() => beginEdit(it)}
										aria-label={`Edit ${it.label}`}>✎</button
									>
									<form method="POST" action="?/removeCost" use:enhance style="display:inline">
										<input type="hidden" name="itemId" value={it.id} />
										<button type="submit" class="iconbtn" aria-label={`Remove ${it.label}`}
											>✕</button
										>
									</form>
								</td>
							</tr>
						{/each}
						{#if data.budget.items.length === 0}
							<tr
								><td colspan="5" class="muted">No costs yet. Add your first estimate above.</td></tr
							>
						{/if}
					</tbody>
					<tfoot>
						<tr>
							<td colspan="3">Total</td>
							<td class="r strong">{fmt(grand)}</td>
							<td></td>
						</tr>
					</tfoot>
				</table>
			</div>
		{/if}
	</div>
</div>

{#if adding}
	{@const kind = adding}
	<Modal
		open
		title={kind === 'task' ? 'Add a task' : 'Add a packing item'}
		size="sm"
		onclose={() => (adding = null)}
	>
		<form
			method="POST"
			action="?/add"
			class="mform"
			use:enhance={() =>
				async ({ update }) => {
					await update();
					adding = null;
				}}
		>
			<div class="mbody">
				<input type="hidden" name="kind" value={kind} />
				<label>
					<span>What needs doing?</span>
					<input
						name="label"
						placeholder={kind === 'task' ? 'Apply for a visa' : 'Power adapter'}
						required
						use:focusOnMount
					/>
				</label>
				<fieldset class="who">
					<legend>Who has to do it?</legend>
					<p class="hint muted">
						Pick more than one and each person ticks their own box, so the task isn't done until
						everyone is. Leave empty for a one-off the group only needs once.
					</p>
					<div class="wholist" bind:this={wholistEl}>
						{#each data.members as m (m.id)}
							<label class="wholine">
								<input type="checkbox" name="assignee" value={m.id} />
								<span class="pname">{m.name}{m.id === data.me ? ' (you)' : ''}</span>
							</label>
						{/each}
						{#if data.members.length === 0}<p class="muted empty">No members yet.</p>{/if}
					</div>
					{#if data.members.length > 2}
						<div class="wholistfoot">
							<button type="button" class="linkbtn" onclick={() => setAllAssignees(true)}
								>Select everyone</button
							>
							<button type="button" class="linkbtn" onclick={() => setAllAssignees(false)}
								>Clear</button
							>
						</div>
					{/if}
				</fieldset>
			</div>
			<div class="mfoot">
				<button type="button" class="btn" onclick={() => (adding = null)}>Cancel</button>
				<button type="submit" class="btn primary">Add</button>
			</div>
		</form>
	</Modal>
{/if}

{#if editing}
	{@const e = editing}
	<Modal
		open
		title={e.id ? 'Edit cost' : 'Add cost'}
		size="sm"
		onclose={() => (editing = null)}
	>
		<form
			method="POST"
			action={e.id ? '?/saveCost' : '?/addCost'}
			class="mform"
			use:enhance={() =>
				async ({ update }) => {
					await update();
					editing = null;
				}}
		>
			<div class="mbody">
				{#if e.id}<input type="hidden" name="itemId" value={e.id} />{/if}
				<label>
					<span>What is it?</span>
					<input
						name="label"
						bind:value={e.label}
						placeholder="Museum tickets"
						required
						use:focusOnMount
					/>
				</label>
				<div class="frow">
					<label class="amtf">
						<span>Amount ({data.currency})</span>
						<input
							name="amount"
							type="number"
							min="0"
							step="1"
							bind:value={e.amount}
							placeholder="0"
							required
						/>
					</label>
					<label class="grow">
						<span>Category</span>
						<Select name="category" bind:value={e.category} options={catOptions} ariaLabel="Category" />
					</label>
					<label class="grow">
						<span>City</span>
						<Select name="cityId" bind:value={e.cityId} options={cityOptions} ariaLabel="City" />
					</label>
				</div>
			</div>
			<div class="mfoot">
				<button type="button" class="btn" onclick={() => (editing = null)}>Cancel</button>
				<button type="submit" class="btn primary">{e.id ? 'Save changes' : 'Add cost'}</button>
			</div>
		</form>
	</Modal>
{/if}

<style>
	.layout {
		display: grid;
		grid-template-columns: 190px minmax(0, 1fr);
		gap: 1.6rem;
		align-items: start;
	}
	.panel {
		min-width: 0;
	}
	/* Only the action button lives here now, so it sits at the trailing edge;
	   the row still reserves --phead-h so switching section never moves the card
	   below it. */
	.phead {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		min-height: var(--phead-h);
		margin-bottom: 1rem;
	}
	.note {
		border-radius: var(--r-sm);
		padding: 0.6rem 0.85rem;
		font-size: 0.9rem;
		margin-bottom: 1rem;
	}
	.note.error {
		background: var(--danger-soft, #fdecea);
		color: var(--danger-ink, #a12b21);
	}
	.block {
		padding: 1.2rem 1.3rem;
		min-width: 0;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.4rem;
		border-radius: var(--r);
		font-size: 0.94rem;
		min-width: 0;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.empty {
		color: var(--ink-faint);
		font-size: 0.9rem;
		padding: 0.5rem 0.4rem;
	}
	.chk {
		display: flex;
		flex: 0 0 auto;
	}
	.box {
		width: 18px;
		height: 18px;
		border-radius: 5px;
		border: 1px solid var(--line);
		background: var(--surface);
		cursor: pointer;
		display: grid;
		place-items: center;
		font-size: 0.72rem;
		color: #fff;
		padding: 0;
		flex: 0 0 auto;
	}
	.box.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.box.other {
		cursor: default;
		border-style: dashed;
		background: var(--surface-2);
	}
	.lbl {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chip.warn {
		flex: 0 0 auto;
	}
	.done .lbl {
		color: var(--ink-faint);
		text-decoration: line-through;
	}

	/* Per-person progress. The bar carries the at-a-glance signal; the count is
	   the accessible text, and the whole thing expands the roster. */
	.rosterrow {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex: 0 0 auto;
		min-width: 0;
	}
	.solo {
		font-size: 0.74rem;
		color: var(--ink-soft);
		max-width: 9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.prog {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		border: 1px solid var(--line);
		background: var(--surface);
		border-radius: 999px;
		padding: 0.12rem 0.5rem 0.12rem 0.4rem;
		cursor: pointer;
		font: inherit;
		font-size: 0.74rem;
		color: var(--ink-soft);
	}
	.prog:hover {
		border-color: var(--accent);
	}
	.bar {
		display: block;
		width: 34px;
		height: 4px;
		border-radius: 999px;
		background: var(--line);
		overflow: hidden;
		flex: 0 0 auto;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.pcount {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.youtag {
		font-size: 0.72rem;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		background: var(--surface-2);
		color: var(--ink-faint);
		white-space: nowrap;
		flex: 0 0 auto;
	}
	.youtag.on {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}

	.people {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.3rem;
		padding: 0.1rem 0.4rem 0.6rem 2rem;
	}
	.person {
		min-width: 0;
	}
	.pchip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font: inherit;
		font-size: 0.76rem;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink-soft);
		border-radius: 999px;
		padding: 0.14rem 0.55rem;
		max-width: 11rem;
		cursor: pointer;
	}
	.pchip.static {
		cursor: default;
	}
	.pchip.on {
		background: var(--accent-soft);
		border-color: transparent;
		color: var(--accent-ink);
	}
	.pchip .tick {
		display: grid;
		place-items: center;
		width: 12px;
		height: 12px;
		border-radius: 4px;
		border: 1px solid currentColor;
		font-size: 0.6rem;
		flex: 0 0 auto;
		opacity: 0.7;
	}
	.pchip.on .tick {
		opacity: 1;
	}
	.pname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.delf {
		flex: 0 0 auto;
	}
	.del {
		border: none;
		background: none;
		color: var(--ink-faint);
		font-size: 1.05rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.2rem;
		opacity: 0;
	}
	.row:hover .del,
	.del:focus-visible {
		opacity: 1;
	}
	.del:hover {
		color: var(--danger, #b4462a);
	}

	/* Add-task modal */
	.mform :global(.mbody) {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.mform label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
		min-width: 0;
	}
	.mform input[name='label'],
	.mform input[type='number'] {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		font: inherit;
		background: var(--surface);
		color: var(--ink);
		min-width: 0;
		max-width: 100%;
	}
	.who {
		border: 1px solid var(--line);
		border-radius: var(--r);
		padding: 0.7rem 0.8rem;
		margin: 0;
		min-width: 0;
	}
	.who legend {
		font-size: 0.8rem;
		color: var(--ink-soft);
		padding: 0 0.3rem;
	}
	.hint {
		margin: 0 0 0.5rem;
		font-size: 0.78rem;
		text-wrap: pretty;
	}
	.wholist {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(9rem, 100%), 1fr));
		gap: 0.15rem;
		max-height: 12rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.wholistfoot {
		display: flex;
		gap: 0.75rem;
		padding: 0.4rem 0.3rem 0;
	}
	.linkbtn {
		border: 0;
		background: none;
		padding: 0;
		font: inherit;
		font-size: 0.78rem;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}
	.mform .wholine {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.85rem;
		color: var(--ink);
		padding: 0.25rem 0.3rem;
		border-radius: var(--r-sm);
		cursor: pointer;
		min-width: 0;
	}
	.wholine:hover {
		background: var(--surface-2);
	}
	.frow {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.frow .grow {
		flex: 1 1 130px;
	}
	.frow .amtf {
		flex: 0 1 130px;
	}

	/* Estimated costs */
	.summary {
		display: flex;
		align-items: flex-end;
		gap: 1.5rem;
		flex-wrap: wrap;
		min-width: 0;
		margin-bottom: 1rem;
	}
	.stat {
		display: flex;
		flex-direction: column;
	}
	.stat span {
		font-size: 0.8rem;
	}
	.stat strong {
		font-family: var(--serif);
		font-size: 1.5rem;
	}
	.cats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-bottom: 1rem;
	}
	.catchip {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.3rem 0.8rem;
		background: var(--surface);
		min-width: 0;
	}
	.catchip span {
		font-size: 0.78rem;
	}
	.catchip strong {
		font-size: 0.9rem;
	}
	.table {
		padding: 0;
		overflow: hidden;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
	}
	th,
	td {
		padding: 0.7rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--line);
		font-size: 0.92rem;
	}
	th {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-faint);
		font-weight: 500;
	}
	th:nth-child(2),
	td:nth-child(2) {
		width: 22%;
	}
	th:nth-child(3),
	td:nth-child(3) {
		width: 18%;
	}
	th:nth-child(4),
	td:nth-child(4) {
		width: 16%;
	}
	th:last-child,
	td:last-child {
		width: 5.5rem;
	}
	tbody tr:hover {
		background: var(--surface-2);
	}
	tfoot td {
		border-bottom: none;
		font-weight: 500;
		background: var(--surface-2);
	}
	.cell {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.r {
		text-align: right;
	}
	.strong {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.pill {
		font-size: 0.74rem;
		padding: 0.12rem 0.5rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-ink);
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.acts {
		white-space: nowrap;
	}
	.iconbtn {
		border: none;
		background: none;
		color: var(--ink-faint);
		cursor: pointer;
		padding: 0.15rem 0.3rem;
		font-size: 0.9rem;
		border-radius: var(--r-sm);
	}
	.iconbtn:hover {
		color: var(--ink);
		background: var(--surface);
	}

	@media (max-width: 860px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
	}
</style>
