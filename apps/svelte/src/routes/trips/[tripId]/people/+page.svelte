<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const members = $derived(data.people);
</script>

<div class="head">
	<p class="muted">Who's coming, and who still needs an invite.</p>
</div>

{#if form?.error}
	<p class="note error">{form.error}</p>
{:else if form?.ok && form?.message}
	<p class="note ok">{form.message}</p>
{/if}

<div class="grid" class:solo={!data.organizer}>
	<section class="card">
		<h3>Members</h3>
		<ul class="people">
			{#each members as p}
				<li>
					<span class="avatar">{p.name[0]}</span>
					<span class="who">
						<span class="name">
							<span class="nametext" title={p.name}>{p.name}</span>
							{#if p.id === data.me}<span class="tag you">you</span>{/if}
							{#if p.role === 'organizer'}<span class="tag org">organizer</span>{/if}
							{#if p.placeholder}<span class="tag invited">invited</span>
							{:else if p.seeded}<span class="tag seed">sample</span>{/if}
						</span>
						<span class="email muted"
							>{p.placeholder
								? `${p.email} (not joined yet)`
								: p.seeded
									? 'Sample companion'
									: p.email}</span
						>
					</span>
					{#if data.organizer && p.role !== 'organizer'}
						<form method="POST" action="?/remove" use:enhance>
							<input type="hidden" name="userId" value={p.id} />
							<button class="link-btn" type="submit" aria-label={`Remove ${p.name}`}>Remove</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	{#if data.organizer}
		<section class="card invitecard">
			<h3>Invite someone</h3>
			<form method="POST" action="?/invite" class="invite-form" use:enhance>
				<input
					type="email"
					name="email"
					placeholder="name@example.com"
					required
					autocomplete="off"
				/>
				<button class="btn primary" type="submit">Send invite</button>
			</form>
			<p class="hint muted">
				If they already have an account they join right away. Otherwise they appear as a placeholder
				and take over the spot (and any expenses assigned to them) when they register with this
				email.
			</p>
		</section>
	{/if}
</div>

<style>
	.head {
		margin-bottom: 1.2rem;
	}
	.head .muted {
		margin: 0;
	}
	.note {
		border-radius: 8px;
		padding: 0.6rem 0.85rem;
		font-size: 0.9rem;
		margin-bottom: 1rem;
	}
	.note.error {
		background: var(--danger-soft, #fdecea);
		color: var(--danger-ink, #a12b21);
	}
	.note.ok {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	/* Members takes the space it needs; Invite sits beside it at a fixed width and
	   drops underneath once there isn't room for both. */
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: 1.2rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	/* No invite card to sit beside, so don't leave a hole where it would be. */
	.grid.solo {
		grid-template-columns: minmax(0, 1fr);
	}
	.invitecard {
		position: sticky;
		top: 1rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 1.2rem 1.3rem;
	}
	.card h3 {
		font-size: 1.05rem;
		margin-bottom: 0.9rem;
	}
	.people {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0.15rem 1.4rem;
		padding: 0;
		margin: 0;
	}
	/* Row separators can't work here: with an auto-fill grid the last item of each
	   column isn't :last-child, so one column keeps a dangling line. Hover
	   highlighting is column-count independent and matches the expense picker. */
	.people li {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.5rem 0.5rem;
		border-radius: var(--r-sm);
	}
	.people li:hover {
		background: var(--surface-2);
	}
	.avatar {
		width: 34px;
		height: 34px;
		border-radius: 999px;
		display: grid;
		place-items: center;
		background: var(--accent-soft);
		color: var(--accent-ink);
		font-weight: 600;
		flex-shrink: 0;
	}
	.who {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.name {
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.nametext {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name .tag {
		flex: 0 0 auto;
	}
	.email {
		font-size: 0.82rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.08rem 0.4rem;
		border-radius: 999px;
	}
	.tag.org {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	.tag.you {
		background: var(--line);
		color: var(--ink-soft);
	}
	.tag.seed {
		background: transparent;
		color: var(--ink-faint);
		border: 1px solid var(--line);
	}
	.tag.invited {
		background: transparent;
		color: var(--accent-ink);
		border: 1px solid var(--accent-soft);
	}
	.invite-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.invite-form input {
		min-width: 0;
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		font: inherit;
	}
	.invite-form .btn {
		justify-content: center;
	}
	.hint {
		font-size: 0.82rem;
		margin-top: 0.6rem;
	}
	.link-btn {
		background: none;
		border: none;
		color: var(--ink-faint);
		font-size: 0.82rem;
		cursor: pointer;
		padding: 0.2rem 0.3rem;
	}
	.link-btn:hover {
		color: var(--danger-ink, #a12b21);
	}
</style>
