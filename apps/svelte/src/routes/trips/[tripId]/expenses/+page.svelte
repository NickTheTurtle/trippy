<script lang="ts">
	import { enhance } from '$app/forms';
	import Select from '$lib/components/Select.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import SectionNav, { type SectionItem } from '$lib/components/SectionNav.svelte';
	import { focusOnMount } from '$lib/focus';
	import { splitByWeight, type SplitMode } from '@trippy/core/split';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let section = $state('expenses');
	let showAdd = $state(false);
	let amount = $state('');
	let currency = $state(data.currency);
	let payerId = $state(data.members[0]?.id ?? '');
	let splitMode = $state<SplitMode>('even');
	/** Who is in on this expense. Everyone is included by default. */
	let picked = $state<Set<string>>(new Set(data.members.map((m) => m.id)));
	/** Per-person share count (`shares` mode) or amount (`exact` mode), as typed. */
	let weights = $state<Record<string, string>>({});

	const currencyOptions = $derived(data.currencies.map((c) => ({ value: c, label: c })));
	const payerOptions = $derived(data.members.map((m) => ({ value: m.id, label: m.name })));
	const splitModeOptions: { value: SplitMode; label: string; hint: string }[] = [
		{ value: 'even', label: 'Evenly', hint: 'Everyone selected pays the same.' },
		{ value: 'shares', label: 'By shares', hint: 'Weight each person: 2 shares pays double.' },
		{ value: 'exact', label: 'By amount', hint: 'Type what each person owes.' }
	];

	const totalCents = $derived(Math.round((Number(amount) || 0) * 100));
	/** A negative amount is money coming back to the group: a refund or payout. */
	const income = $derived(totalCents < 0);
	const chosen = $derived(data.members.filter((m) => picked.has(m.id)));

	function weightOf(id: string): number {
		const raw = Number(weights[id]);
		if (!Number.isFinite(raw) || raw <= 0) return 0;
		return splitMode === 'exact' ? Math.round(raw * 100) : raw;
	}

	/** Live preview of what each selected person owes, in cents. */
	const preview = $derived.by(() => {
		const empty = new Map<string, number>();
		// In `exact` mode the typed number is the share, so the input already
		// shows it; only `even` and `shares` need a computed preview.
		if (chosen.length === 0 || splitMode === 'exact') return empty;
		const w = chosen.map((m) => (splitMode === 'even' ? 1 : weightOf(m.id)));
		if (splitMode === 'shares' && w.every((v) => v <= 0)) return empty;
		const cents = splitByWeight(totalCents, w);
		return new Map(chosen.map((m, i) => [m.id, cents[i]]));
	});

	/**
	 * In `exact` mode the typed amounts must add up to the total. They are always
	 * entered as positive magnitudes, so compare against `|total|`; an income
	 * entry of -60 is still "three people at 20 each".
	 */
	const exactSum = $derived(
		splitMode === 'exact' ? chosen.reduce((a, m) => a + weightOf(m.id), 0) : 0
	);
	const exactOff = $derived(splitMode === 'exact' ? Math.abs(totalCents) - exactSum : 0);
	const canSave = $derived(
		totalCents !== 0 &&
			chosen.length > 0 &&
			(splitMode === 'even' ||
				(splitMode === 'shares' && chosen.some((m) => weightOf(m.id) > 0)) ||
				(splitMode === 'exact' && exactOff === 0))
	);

	function fmt(cents: number): string {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: data.currency
		}).format(cents / 100);
	}
	function fmtIn(cents: number, cur: string): string {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: cur
		}).format(cents / 100);
	}
	function fmtUnits(n: number): string {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: data.currency
		}).format(n);
	}
	function fmtCents(cents: number, cur: string): string {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(
			cents / 100
		);
	}

	/** A share count and an amount aren't interchangeable, so start clean on a mode change. */
	function setMode(mode: SplitMode) {
		if (mode === splitMode) return;
		splitMode = mode;
		weights = {};
	}

	function splitLabel(mode: SplitMode, n: number): string {
		const people = `${n} ${n === 1 ? 'way' : 'ways'}`;
		if (mode === 'shares') return `split by shares, ${people}`;
		if (mode === 'exact') return `split by amount, ${people}`;
		return `split ${people}`;
	}

	function toggle(id: string) {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		picked = next;
	}
	function pickAll(on: boolean) {
		picked = on ? new Set(data.members.map((m) => m.id)) : new Set();
	}
	/** Give everyone still blank an even slice of what's left to allocate. */
	function autofillExact() {
		const blanks = chosen.filter((m) => weightOf(m.id) === 0);
		const rest = Math.abs(totalCents) - exactSum;
		if (blanks.length === 0 || rest <= 0) return;
		const each = splitByWeight(rest, new Array(blanks.length).fill(1));
		const next = { ...weights };
		blanks.forEach((m, i) => (next[m.id] = (each[i] / 100).toFixed(2)));
		weights = next;
	}

	function openAdd() {
		picked = new Set(data.members.map((m) => m.id));
		weights = {};
		amount = '';
		splitMode = 'even';
		payerId = data.members[0]?.id ?? '';
		currency = data.currency;
		showAdd = true;
	}

	const owed = $derived(data.balances.filter((b) => b.net > 0.01));
	const owes = $derived(data.balances.filter((b) => b.net < -0.01));
	const unsettled = $derived(owed.length + owes.length);

	const sections: SectionItem[] = $derived([
		{ id: 'expenses', label: 'Expenses', badge: data.expenses.length },
		{ id: 'balances', label: 'Balances', badge: unsettled === 0 ? '✓' : unsettled },
		{ id: 'settle', label: 'Settle up', badge: data.settlement.length || '✓' }
	]);
</script>

<div class="layout">
	<SectionNav items={sections} bind:value={section} ariaLabel="Expense sections" />

	<div class="panel">
		{#if section === 'expenses'}
			<div class="phead">
				<p class="muted">Log who paid. Enter a negative amount for a refund or payout.</p>
				<button class="btn primary" onclick={openAdd}>+ Add expense</button>
			</div>
			<div class="card list">
				{#if data.expenses.length === 0}
					<p class="muted empty">No expenses yet. Add the first one.</p>
				{:else}
					<ul>
						{#each data.expenses as e (e.id)}
							{@const credit = e.amount_cents < 0}
							<li>
								<span class="av" class:credit>{e.payer_name[0]}</span>
								<div class="ei">
									<span class="ed" title={e.description}>
										{e.description}
										{#if credit}<span class="tag credit">income</span>{/if}
									</span>
									<span class="muted"
										>{e.payer_name}
										{credit ? 'received' : 'paid'} · {splitLabel(e.split_mode, e.participants)}</span
									>
								</div>
								<span class="amt" class:credit>
									{fmtIn(e.amount_cents, e.currency)}
									{#if e.converted}<span class="conv muted">≈ {fmt(e.home_cents)}</span>{/if}
								</span>
								<form method="POST" action="?/remove" use:enhance>
									<input type="hidden" name="id" value={e.id} />
									<button class="del" title="Delete" aria-label="Delete expense">×</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else if section === 'balances'}
			<div class="phead">
				<p class="muted">Net position per person, in {data.currency}.</p>
			</div>
			<div class="card bal">
				{#if unsettled === 0}
					<p class="muted empty">Everyone is even.</p>
				{:else}
					<ul class="blist">
						{#each owed as b (b.name)}
							<li>
								<span class="bname" title={b.name}>{b.name}</span>
								<span class="pos">+{fmtUnits(b.net)}</span>
							</li>
						{/each}
						{#each owes as b (b.name)}
							<li>
								<span class="bname" title={b.name}>{b.name}</span>
								<span class="neg">{fmtUnits(b.net)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else}
			<div class="phead">
				<p class="muted">Minimum transfers to clear all balances.</p>
			</div>
			<div class="card settle">
				{#if data.settlement.length === 0}
					<p class="muted empty">Nothing to settle.</p>
				{:else}
					<ul class="slist">
						{#each data.settlement as t (t.from + t.to)}
							<li>
								<span class="from" title={t.from}>{t.from}</span>
								<span class="arrow">pays</span>
								<span class="to" title={t.to}>{t.to}</span>
								<span class="amt">{fmtUnits(t.amount)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
</div>

{#if showAdd}
	<Modal open={showAdd} title={income ? 'Add income' : 'Add expense'} onclose={() => (showAdd = false)}>
		<form
			method="POST"
			action="?/add"
			class="mform"
			use:enhance={() =>
				async ({ update, result }) => {
					await update({ reset: false });
					if (result.type === 'success') showAdd = false;
				}}
		>
			<div class="mbody">
				<div class="fields">
					<label class="f-desc">
						<span>Description</span>
						<input
							name="description"
							use:focusOnMount
							required
						/>
					</label>
					<label class="f-amt">
						<span>Amount</span>
						<input
							name="amount"
							type="number"
							step="0.01"
							inputmode="decimal"
							bind:value={amount}
							required
						/>
					</label>
					<label class="f-cur">
						<span>Currency</span>
						<Select
							name="currency"
							bind:value={currency}
							options={currencyOptions}
							ariaLabel="Currency"
						/>
					</label>
					<label class="f-payer">
						<span>{income ? 'Received by' : 'Paid by'}</span>
						<Select name="payerId" bind:value={payerId} options={payerOptions} ariaLabel="Paid by" />
					</label>
				</div>

				{#if income}
					<p class="hint credit">
						Negative amount, saved as income. Everyone selected is credited instead of charged.
					</p>
				{:else}
					<p class="hint">Use a negative amount for a refund or payout the group receives.</p>
				{/if}

				<div class="splitbox">
					<div class="splithead">
						<span class="flabel">Split</span>
						<div class="modes" role="group" aria-label="Split method">
							{#each splitModeOptions as o (o.value)}
								<button
									type="button"
									class="mode"
									class:on={splitMode === o.value}
									aria-pressed={splitMode === o.value}
									onclick={() => setMode(o.value)}>{o.label}</button
								>
							{/each}
						</div>
					</div>
					<input type="hidden" name="splitMode" value={splitMode} />
					<p class="hint modehint">
						{splitModeOptions.find((o) => o.value === splitMode)?.hint}
					</p>

					<div class="pickhead">
						<span class="muted small pickcount">
							{chosen.length} of {data.members.length} selected
							{#if splitMode === 'exact' && totalCents !== 0}
								· {exactOff === 0
									? 'fully allocated'
									: `${fmtCents(Math.abs(exactOff), currency)} ${exactOff > 0 ? 'left' : 'over'}`}
							{/if}
						</span>
						<span class="pickacts">
							{#if splitMode === 'exact'}
								<button type="button" class="link" onclick={autofillExact}>Split the rest</button>
							{/if}
							<button type="button" class="link" onclick={() => pickAll(true)}>All</button>
							<button type="button" class="link" onclick={() => pickAll(false)}>None</button>
						</span>
					</div>

					<ul class="picklist">
						{#each data.members as m (m.id)}
							{@const on = picked.has(m.id)}
							<li class:on>
								<label class="pick">
									<input
										type="checkbox"
										name="participantIds"
										value={m.id}
										checked={on}
										onchange={() => toggle(m.id)}
									/>
									<span class="pname" title={m.name}>{m.name}</span>
								</label>
								{#if on && splitMode !== 'even'}
									<input
										class="wt"
										name={`w:${m.id}`}
										type="number"
										min="0"
										step={splitMode === 'exact' ? '0.01' : '1'}
										placeholder={splitMode === 'exact' ? '0.00' : '1'}
										aria-label={`${splitMode === 'exact' ? 'Amount' : 'Shares'} for ${m.name}`}
										bind:value={weights[m.id]}
									/>
								{/if}
								{#if on && totalCents !== 0 && preview.has(m.id)}
									<span class="ppreview" class:credit={income}
										>{fmtCents(preview.get(m.id) ?? 0, currency)}</span
									>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			</div>

			<div class="mfoot">
				{#if form?.error}<p class="note error mfoot-note" role="alert">{form.error}</p>{/if}
				<button class="btn" type="button" onclick={() => (showAdd = false)}>Cancel</button>
				<button class="btn primary" type="submit" disabled={!canSave}>
					{income ? 'Save income' : 'Save expense'}
				</button>
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
	.phead {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		min-height: var(--phead-h);
		margin-bottom: 1rem;
	}
	.phead .muted {
		margin: 0;
		min-width: 0;
	}
	/* Add-expense modal. Chrome lives in Modal.svelte; this is the form inside it. */
	.note {
		margin: 0;
		border-radius: var(--r-sm);
		padding: 0.5rem 0.7rem;
		font-size: 0.86rem;
	}
	.note.error {
		background: var(--danger-soft, #fdecea);
		color: var(--danger-ink, #a12b21);
	}
	.mbody {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
	}
	/* A 12-column grid, so the four top fields keep their proportions instead of
	   wrapping at hard pixel widths the moment the modal narrows. */
	.fields {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 0.85rem 0.7rem;
	}
	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.82rem;
		color: var(--ink-soft);
		min-width: 0;
	}
	.f-desc {
		grid-column: span 12;
	}
	.f-amt {
		grid-column: span 4;
	}
	.f-cur {
		grid-column: span 3;
	}
	.f-payer {
		grid-column: span 5;
	}
	.mbody input {
		min-width: 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		font: inherit;
		color: var(--ink);
	}
	/* Only the top block's text inputs stretch. Checkboxes and the per-person
	   weight inputs below keep their intrinsic size. */
	.fields input {
		width: 100%;
	}
	.mbody input[type='checkbox'] {
		padding: 0;
		border: none;
		background: none;
	}
	.hint {
		margin: -0.5rem 0 0;
		font-size: 0.82rem;
		color: var(--ink-faint);
	}
	.hint.credit {
		color: var(--accent-ink);
	}
	/* Explicit column gaps, so spacing doesn't depend on margin collapsing. */
	.splitbox {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		padding: 0.85rem 0.9rem;
		background: var(--surface-2);
	}
	.splithead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.flabel {
		font-size: 0.82rem;
		color: var(--ink-soft);
	}
	.modes {
		display: flex;
		gap: 0.3rem;
		background: var(--surface-2);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.2rem;
		width: fit-content;
		max-width: 100%;
		flex-wrap: wrap;
	}
	.mode {
		border: none;
		background: none;
		border-radius: 999px;
		padding: 0.3rem 0.85rem;
		font: inherit;
		font-size: 0.85rem;
		color: var(--ink-soft);
		cursor: pointer;
		white-space: nowrap;
	}
	.mode.on {
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.08));
		font-weight: 500;
	}
	.modehint {
		margin: 0;
	}
	.pickhead {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
		margin-bottom: 0.4rem;
		margin-top: 0.35rem;
	}
	.pickcount {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pickacts {
		flex: 0 0 auto;
		display: flex;
		gap: 0.7rem;
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.8rem;
		color: var(--accent-ink);
		cursor: pointer;
	}
	.picklist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 0.1rem 1rem;
	}
	.picklist li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.35rem;
		border-radius: var(--r-sm);
		font-size: 0.88rem;
	}
	.picklist li.on {
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex: 1;
		min-width: 0;
		cursor: pointer;
		user-select: none;
	}
	.pick input {
		flex: 0 0 auto;
		accent-color: var(--accent);
	}
	.pname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.wt {
		flex: 0 0 auto;
		width: 4.6rem;
		text-align: right;
		padding: 0.25rem 0.4rem !important;
		font-size: 0.85rem;
	}
	.ppreview {
		flex: 0 0 auto;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
		color: var(--ink-faint);
	}
	.ppreview.credit {
		color: var(--accent-ink);
	}
	.card {
		padding: 1.2rem 1.3rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.empty {
		font-size: 0.9rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.list li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.av {
		width: 30px;
		height: 30px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-ink);
		display: grid;
		place-items: center;
		font-size: 0.82rem;
		font-weight: 600;
		flex: none;
	}
	.ei {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.ed {
		font-size: 0.93rem;
		font-weight: 500;
	}
	.ed,
	.ei .muted {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.av.credit {
		background: var(--surface-2);
		color: var(--ink-soft);
	}
	.tag.credit {
		font-size: 0.66rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--accent-soft);
		color: var(--accent-ink);
		margin-left: 0.25rem;
	}
	.list .amt.credit {
		color: var(--accent-ink);
	}
	.ei .muted {
		font-size: 0.8rem;
	}
	.amt {
		margin-left: auto;
		font-weight: 600;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		text-align: right;
	}
	.conv {
		font-size: 0.75rem;
		font-weight: 500;
	}
	.del {
		border: none;
		background: none;
		color: var(--ink-faint);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.2rem;
	}
	.del:hover {
		color: var(--danger, #b4462a);
	}
	.blist {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0.35rem 1.2rem;
	}
	.blist li {
		display: flex;
		justify-content: space-between;
		gap: 0.6rem;
		font-size: 0.9rem;
	}
	.bname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pos,
	.neg {
		flex: 0 0 auto;
	}
	.pos {
		color: var(--accent-ink);
		font-weight: 600;
	}
	.neg {
		color: var(--danger, #b4462a);
		font-weight: 600;
	}
	.slist {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 0.35rem;
	}
	.settle li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.92rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-2);
		border-radius: var(--r);
	}
	.from,
	.to {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.from {
		font-weight: 600;
	}
	.arrow {
		color: var(--ink-faint);
		font-size: 0.82rem;
		flex: 0 0 auto;
	}
	.to {
		font-weight: 600;
		color: var(--accent-ink);
	}
	.settle .amt {
		flex: 0 0 auto;
		margin-left: auto;
		color: var(--ink);
	}
	@media (max-width: 860px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
	}
	@media (max-width: 560px) {
		.f-amt,
		.f-cur,
		.f-payer {
			grid-column: span 12;
		}
	}
</style>
