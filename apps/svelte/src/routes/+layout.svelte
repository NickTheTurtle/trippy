<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { enhance } from '$app/forms';

	let { children, data } = $props();

	let menuOpen = $state(false);
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<svelte:head>
	<title>Trippy</title>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&family=Inter:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<header class="topbar">
	<div class="container bar">
		<a class="brand" href={data?.user ? '/trips' : '/'}>
			<span class="mark">◍</span>
			<span>Trippy</span>
		</a>
		<nav class="links">
			{#if data?.user}
				<div class="usermenu" class:open={menuOpen}>
					<button
						class="usertrigger"
						type="button"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onclick={(e) => {
							e.stopPropagation();
							menuOpen = !menuOpen;
						}}
					>
						<span class="uavatar">{data.user.name.slice(0, 1).toUpperCase()}</span>
						<span class="uname">{data.user.name}</span>
						<span class="ucaret" aria-hidden="true">▾</span>
					</button>
					{#if menuOpen}
						<div class="usermenu-panel" role="menu">
							<a href="/account" role="menuitem" onclick={() => (menuOpen = false)}>Account settings</a>
							<form method="POST" action="/logout" use:enhance>
								<button type="submit" role="menuitem">Log out</button>
							</form>
						</div>
					{/if}
				</div>
			{:else}
				<a href="/login">Log in</a>
				<a class="btn primary" href="/register">Start planning</a>
			{/if}
		</nav>
	</div>
</header>

<main>
	{@render children()}
</main>

<style>
	main {
		/* The footer used to supply the bottom breathing room; keep it now that it's gone. */
		padding-bottom: 4rem;
	}

	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		background: rgba(251, 250, 246, 0.85);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--line);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 64px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--serif);
		font-size: 1.25rem;
		font-weight: 560;
	}
	.mark {
		color: var(--accent);
		font-size: 1.4rem;
	}
	.links {
		display: flex;
		align-items: center;
		gap: 1.4rem;
		font-size: 0.92rem;
		font-weight: 500;
	}
	.links a:not(.btn):hover {
		color: var(--accent);
	}
	.links form {
		margin: 0;
	}
	.usermenu {
		position: relative;
	}
	.usertrigger {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		background: none;
		border: 1px solid transparent;
		border-radius: 999px;
		padding: 0.25rem 0.55rem 0.25rem 0.3rem;
		font: inherit;
		font-weight: 500;
		color: var(--ink);
		cursor: pointer;
	}
	.usertrigger:hover,
	.usermenu.open .usertrigger {
		border-color: var(--line);
		background: var(--surface);
	}
	.uavatar {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		font-size: 0.8rem;
		font-weight: 600;
	}
	.ucaret {
		font-size: 0.7rem;
		color: var(--ink-faint);
	}
	.usermenu-panel {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		min-width: 12rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r);
		box-shadow: var(--shadow);
		padding: 0.35rem;
		display: flex;
		flex-direction: column;
		z-index: 30;
	}
	.usermenu-panel a,
	.usermenu-panel button {
		text-align: left;
		width: 100%;
		background: none;
		border: none;
		font: inherit;
		font-size: 0.9rem;
		color: var(--ink);
		padding: 0.55rem 0.65rem;
		border-radius: var(--r-sm);
		cursor: pointer;
	}
	.usermenu-panel a:hover,
	.usermenu-panel button:hover {
		background: var(--surface-2);
		color: var(--accent-ink);
	}
</style>
