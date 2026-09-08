<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
</script>

<div class="authwrap">
	<div class="card auth">
		<h2>Welcome back</h2>
		<p class="muted">Log in to keep planning.</p>
		{#if form?.error}<p class="err">{form.error}</p>{/if}
		<form method="POST" use:enhance>
			<label>Email<input name="email" type="email" value={form?.email ?? ''} /></label>
			<label>Password<input name="password" type="password" /></label>
			<button class="btn primary full" type="submit">Log in</button>
		</form>
		<p class="alt muted">New here? <a href="/register">Create an account</a></p>
	</div>
</div>

<style>
	.authwrap {
		display: grid;
		place-items: center;
		padding: 4rem 1.5rem;
	}
	.auth {
		width: 100%;
		max-width: 24rem;
		padding: 2rem;
	}
	.auth h2 {
		font-size: 1.6rem;
	}
	.auth > .muted {
		margin: 0.3rem 0 1.4rem;
	}
	.err {
		background: var(--warn-soft);
		color: var(--warn);
		font-size: 0.85rem;
		padding: 0.55rem 0.75rem;
		border-radius: var(--r);
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
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.full {
		width: 100%;
		justify-content: center;
		margin-top: 0.3rem;
	}
	.alt {
		text-align: center;
		font-size: 0.88rem;
		margin: 1.2rem 0 0;
	}
	.alt a {
		color: var(--accent-ink);
		font-weight: 500;
	}
</style>
