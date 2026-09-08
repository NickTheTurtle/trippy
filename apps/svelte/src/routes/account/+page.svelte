<script lang="ts">
	import { enhance } from '$app/forms';
	import Select from '$lib/components/Select.svelte';
	let { data, form } = $props();

	const profileMsg = $derived(form?.section === 'profile' ? form : null);
	const passwordMsg = $derived(form?.section === 'password' ? form : null);

	let homeTz = $state(data.profile.homeTz);
	const tzOptions = data.timeZones.map((tz: string) => ({ value: tz, label: tz.replace('_', ' ') }));
</script>

<div class="accwrap">
	<header class="acchead">
		<h1>Account settings</h1>
		<p class="muted">Manage how you sign in and how times are shown to you.</p>
	</header>

	<section class="card block">
		<h2>Profile</h2>
		{#if profileMsg?.error}<p class="err">{profileMsg.error}</p>{/if}
		{#if profileMsg?.ok}<p class="ok">Profile saved.</p>{/if}
		<form method="POST" action="?/profile" use:enhance>
			<label>Name<input name="name" type="text" value={data.profile.name} required /></label>
			<label>Email<input name="email" type="email" value={data.profile.email} required /></label>
			<label>
				Home time zone
				<Select name="homeTz" bind:value={homeTz} options={tzOptions} ariaLabel="Home time zone" />
			</label>
			<button class="btn primary" type="submit">Save profile</button>
		</form>
	</section>

	<section class="card block">
		<h2>Password</h2>
		{#if passwordMsg?.error}<p class="err">{passwordMsg.error}</p>{/if}
		{#if passwordMsg?.ok}<p class="ok">Password updated.</p>{/if}
		<form method="POST" action="?/password" use:enhance={() => async ({ update }) => update({ reset: true })}>
			<label>Current password<input name="current" type="password" required /></label>
			<label
				>New password<input name="next" type="password" required />
				<span class="hint muted">At least 8 characters</span></label
			>
			<label>Confirm new password<input name="confirm" type="password" required /></label>
			<button class="btn primary" type="submit">Change password</button>
		</form>
	</section>
</div>

<style>
	.accwrap {
		max-width: 34rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 4rem;
		display: flex;
		flex-direction: column;
		gap: 1.2rem;
	}
	.acchead h1 {
		font-size: 1.7rem;
	}
	.acchead p {
		margin: 0.3rem 0 0;
	}
	.block {
		padding: 1.5rem 1.6rem;
	}
	.block h2 {
		font-size: 1.15rem;
		margin: 0 0 1rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--ink-soft);
	}
	input {
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		font: inherit;
		background: var(--surface);
		color: var(--ink);
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}
	/* Rules the field must satisfy stay visible while typing; a placeholder would
	   vanish at the first keystroke. */
	.hint {
		font-size: 0.78rem;
		font-weight: 400;
	}
	button {
		align-self: flex-start;
		margin-top: 0.3rem;
	}
	.err {
		background: var(--warn-soft);
		color: var(--warn);
		font-size: 0.85rem;
		padding: 0.55rem 0.75rem;
		border-radius: var(--r);
		margin: 0 0 1rem;
	}
	.ok {
		background: var(--accent-soft);
		color: var(--accent-ink);
		font-size: 0.85rem;
		padding: 0.55rem 0.75rem;
		border-radius: var(--r);
		margin: 0 0 1rem;
	}
</style>
