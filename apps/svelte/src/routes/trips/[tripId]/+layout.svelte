<script lang="ts">
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import { focusOnMount } from '$lib/focus';

	let { children, data } = $props();

	let trip = $derived(data.trip);
	let base = $derived(`/trips/${$page.params.tripId}`);

	let showEdit = $state(false);
	let editError = $state('');
	let currency = $state('USD');

	const CURRENCIES = [
		'USD',
		'EUR',
		'GBP',
		'JPY',
		'CAD',
		'AUD',
		'CHF',
		'CNY',
		'INR',
		'MXN',
		'SEK',
		'NZD',
		'SGD',
		'ZAR',
		'BRL'
	].map((c) => ({ value: c, label: c }));

	const tabs = [
		{ slug: 'discover', label: 'Discover' },
		{ slug: 'pretrip', label: 'Preparation' },
		{ slug: 'calendar', label: 'Schedule' },
		{ slug: 'expenses', label: 'Expenses' },
		{ slug: 'people', label: 'People' }
	];

	function isActive(slug: string): boolean {
		return $page.url.pathname === `${base}/${slug}`;
	}

	function openEdit() {
		currency = trip.home_currency;
		editError = '';
		showEdit = true;
	}
</script>

{#if trip}
	<div class="triphead">
		<div class="container">
			<a class="back" href="/trips">← All trips</a>
			<div class="row">
				<div class="titleblock">
					<h1>{trip.name}</h1>
					<p class="muted">{trip.dates}</p>
				</div>
				<div class="members">
					{#each trip.members.slice(0, 8) as m}
						<span class="avatar" title={m}>{m[0]}</span>
					{/each}
					{#if trip.members.length > 8}
						<span class="avatar rest" title={trip.members.slice(8).join(', ')}>
							+{trip.members.length - 8}
						</span>
					{/if}
					{#if trip.role === 'organizer'}
						<button class="btn ghost edit" type="button" onclick={openEdit}>Edit trip</button>
					{/if}
				</div>
			</div>

			<div class="cities">
				{#each trip.cities as c, i}
					<div class="seg">
						<span class="dot"></span>
						<span class="cname">{c.name}</span>
					</div>
					{#if i < trip.cities.length - 1}
						<span class="link"></span>
					{/if}
				{/each}
			</div>

			<nav class="tabs">
				{#each tabs as t}
					<a class="tab" class:active={isActive(t.slug)} href={`${base}/${t.slug}`}>
						{t.label}
					</a>
				{/each}
			</nav>
		</div>
	</div>

	{#if showEdit}
		<Modal open title="Edit trip" size="sm" onclose={() => (showEdit = false)}>
			<form
				method="POST"
				action={`${base}/settings?/edit`}
				class="mform"
				use:enhance={() => async ({ result }) => {
					if (result.type === 'failure') {
						editError = String(result.data?.error ?? 'Could not save.');
						return;
					}
					showEdit = false;
					await invalidateAll();
				}}
			>
				<div class="mbody">
					{#if editError}<p class="ferr" role="alert">{editError}</p>{/if}
					<label>
						<span>Trip name</span>
						<input name="name" value={trip.name} required use:focusOnMount />
					</label>
					<div class="drow">
						<label>
							<span>Start</span>
							<input name="startDate" type="date" value={trip.start_date ?? ''} />
						</label>
						<label>
							<span>End</span>
							<input name="endDate" type="date" value={trip.end_date ?? ''} />
						</label>
						<label class="curf">
							<span>Currency</span>
							<Select name="currency" bind:value={currency} options={CURRENCIES} ariaLabel="Home currency" />
						</label>
					</div>
					<p class="fhint muted">
						The header label is generated from these dates. Currency is what totals and estimates are
						shown in.
					</p>
				</div>
				<div class="mfoot">
					<button class="btn" type="button" onclick={() => (showEdit = false)}>Cancel</button>
					<button class="btn primary" type="submit">Save changes</button>
				</div>
			</form>
		</Modal>
	{/if}

	<main class="container work">
		{@render children()}
	</main>
{:else}
	<main class="container work">
		<p>Trip not found. <a href="/trips">Back to trips</a></p>
	</main>
{/if}

<style>
	.triphead {
		background: var(--surface);
		border-bottom: 1px solid var(--line);
	}
	.back {
		display: inline-block;
		padding: 1.2rem 0 0.6rem;
		font-size: 0.88rem;
		color: var(--ink-faint);
	}
	.back:hover {
		color: var(--accent);
	}
	.row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	.row h1 {
		font-size: 1.9rem;
		overflow-wrap: anywhere;
	}
	.members {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}
	.avatar {
		width: 30px;
		height: 30px;
		border-radius: 999px;
		display: grid;
		place-items: center;
		background: var(--accent-soft);
		color: var(--accent-ink);
		font-size: 0.82rem;
		font-weight: 600;
		border: 2px solid var(--surface);
		margin-left: -6px;
		flex-shrink: 0;
	}
	.avatar.rest {
		background: var(--surface-2, #eef1ec);
		color: var(--ink-soft);
		font-size: 0.72rem;
		cursor: help;
	}
	.edit {
		margin-left: 0.75rem;
		font-size: 0.85rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--line);
		background: var(--surface);
		border-radius: var(--r);
		color: var(--ink);
		cursor: pointer;
		white-space: nowrap;
	}
	.edit:hover {
		background: var(--surface-2);
	}
	.titleblock {
		min-width: 0;
	}
	.drow {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.drow label {
		flex: 1 1 130px;
		min-width: 0;
	}
	.curf {
		flex: 0 1 130px;
	}
	.ferr {
		margin: 0;
		font-size: 0.88rem;
		color: #a33d3d;
	}
	.mform label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
		min-width: 0;
	}
	.mform input {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		font: inherit;
		color: var(--ink);
		min-width: 0;
		max-width: 100%;
	}
	.mform :global(.mbody) {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.fhint {
		font-size: 0.78rem;
		line-height: 1.4;
		margin: 0;
	}
	.cities {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 1.2rem 0 0.4rem;
	}
	.seg {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--accent);
		align-self: center;
	}
	.cname {
		font-weight: 500;
	}
	.link {
		width: 28px;
		height: 1px;
		background: var(--line);
		margin: 0 0.2rem;
	}
	.tabs {
		display: flex;
		gap: 0.3rem;
		margin-top: 1.2rem;
		overflow-x: auto;
	}
	.tab {
		padding: 0.6rem 0.9rem;
		font-size: 0.92rem;
		font-weight: 500;
		color: var(--ink-soft);
		border-bottom: 2px solid transparent;
		white-space: nowrap;
	}
	.tab:hover {
		color: var(--ink);
	}
	.tab.active {
		color: var(--accent-ink);
		border-bottom-color: var(--accent);
	}
	.work {
		padding: 2rem 1.5rem;
	}
</style>
