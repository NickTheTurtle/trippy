<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let showNew = $state(false);
</script>

<section class="container head">
	<div>
		<h1>My trips</h1>
		<p class="muted">Trips you organize or belong to.</p>
	</div>
	<button class="btn primary" onclick={() => (showNew = !showNew)}>New trip</button>
</section>

{#if showNew}
	<section class="container">
		<form class="card newtrip" method="POST" action="?/create" use:enhance>
			{#if form?.error}<p class="err">{form.error}</p>{/if}
			<div class="fields">
				<label>Trip name<input name="name" /></label>
				<label
					>Dates<input name="dates" />
					<span class="hint muted">e.g. Jul 3 – Jul 15, 2027</span></label
				>
				<label>Currency<input name="currency" value="USD" /></label>
			</div>
			<div class="acts">
				<button class="btn" type="button" onclick={() => (showNew = false)}>Cancel</button>
				<button class="btn primary" type="submit">Create trip</button>
			</div>
		</form>
	</section>
{/if}

<section class="container grid">
	{#each data.trips as t}
		<a class="card trip" href={`/trips/${t.id}`}>
			<div class="cover" style={`background:${t.cover}`}>
				<span class="chip">{t.cities.length} {t.cities.length === 1 ? 'city' : 'cities'}</span>
			</div>
			<div class="body">
				<h3>{t.name}</h3>
				<p class="muted dates">{t.dates}</p>
				<p class="route">
					{#if t.cities.length}
						{t.cities.map((c) => c.name).join('  ›  ')}
					{:else}
						No cities yet
					{/if}
				</p>
				<span class="chip accent role">{t.role}</span>
			</div>
		</a>
	{/each}

	{#if data.trips.length === 0}
		<p class="muted empty">No trips yet. Create your first one to get started.</p>
	{/if}
</section>

<style>
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		padding: 3rem 1.5rem 1.5rem;
	}
	.head h1 {
		font-size: 2rem;
	}
	.newtrip {
		padding: 1.4rem;
		margin-bottom: 1.5rem;
	}
	.fields {
		display: grid;
		grid-template-columns: 2fr 1.5fr 1fr;
		gap: 0.9rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--ink-soft);
	}
	input {
		padding: 0.55rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		font: inherit;
		background: var(--surface);
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}
	/* The field takes free text, so the accepted shape has to stay readable while
	   you type it, which a placeholder does not. */
	.hint {
		font-size: 0.75rem;
		font-weight: 400;
	}
	.acts {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 1rem;
	}
	.err {
		color: var(--warn);
		font-size: 0.85rem;
		margin: 0 0 0.8rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1.25rem;
	}
	.trip {
		overflow: hidden;
		transition: box-shadow 0.15s ease, transform 0.1s ease;
	}
	.trip:hover {
		box-shadow: var(--shadow);
		transform: translateY(-2px);
	}
	.cover {
		height: 150px;
		display: flex;
		align-items: flex-start;
		padding: 1rem;
	}
	.cover .chip {
		background: rgba(255, 255, 255, 0.85);
		border: none;
	}
	.body {
		padding: 1.25rem 1.4rem 1.4rem;
	}
	.dates {
		font-size: 0.9rem;
		margin: 0.2rem 0 0.7rem;
	}
	.route {
		font-size: 0.95rem;
		color: var(--ink-soft);
		margin: 0 0 1rem;
	}
	.role {
		text-transform: capitalize;
	}
	.empty {
		grid-column: 1 / -1;
		padding: 2rem 0;
	}
	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.fields {
			grid-template-columns: 1fr;
		}
	}
</style>
