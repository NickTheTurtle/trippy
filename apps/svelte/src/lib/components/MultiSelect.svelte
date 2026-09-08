<script lang="ts">
	interface Option {
		value: string;
		label: string;
	}

	import { anchor } from '$lib/anchor';

	let {
		options,
		selected = $bindable([]),
		name = '',
		placeholder = 'Anyone',
		ariaLabel = 'Assign people',
		compact = false
	}: {
		options: Option[];
		selected?: string[];
		name?: string;
		placeholder?: string;
		ariaLabel?: string;
		compact?: boolean;
	} = $props();

	let open = $state(false);
	let root: HTMLDivElement;
	let trigger = $state<HTMLButtonElement | undefined>(undefined);

	const chosen = $derived(options.filter((o) => selected.includes(o.value)));
	const summary = $derived(
		chosen.length === 0
			? placeholder
			: chosen.length <= 2
				? chosen.map((o) => o.label).join(', ')
				: `${chosen.length} people`
	);

	function toggle(v: string) {
		selected = selected.includes(v)
			? selected.filter((x) => x !== v)
			: [...selected, v];
	}
	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} />

<div class="msel" class:compact bind:this={root}>
	{#if name}<input type="hidden" {name} value={selected.join(',')} />{/if}
	<button
		type="button"
		class="mtrigger"
		bind:this={trigger}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={ariaLabel}
		onclick={() => (open = !open)}
	>
		<span class="mlabel" class:placeholder={chosen.length === 0}>{summary}</span>
		<span class="mcaret">▾</span>
	</button>
	{#if open}
		<ul
			class="mmenu"
			role="listbox"
			aria-multiselectable="true"
			tabindex="-1"
			use:anchor={{ trigger }}
		>
			{#each options as o (o.value)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={selected.includes(o.value)}
						class="mopt"
						onclick={() => toggle(o.value)}
					>
						<span class="mbox" class:on={selected.includes(o.value)}>
							{#if selected.includes(o.value)}✓{/if}
						</span>
						<span class="mopttext">{o.label}</span>
					</button>
				</li>
			{/each}
			{#if options.length === 0}
				<li class="mempty">No members yet</li>
			{/if}
		</ul>
	{/if}
</div>

<style>
	.msel {
		position: relative;
		/* Same reasoning as Select: shrink rather than overflow a narrow parent. */
		min-width: min(8rem, 100%);
	}
	.mtrigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		font: inherit;
		color: var(--ink);
		cursor: pointer;
		text-align: left;
	}
	.msel.compact .mtrigger {
		padding: 0.3rem 0.5rem;
		font-size: 0.82rem;
	}
	.mtrigger:hover {
		border-color: var(--accent);
	}
	.mlabel {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mlabel.placeholder {
		color: var(--ink-faint);
	}
	.mcaret {
		font-size: 0.7rem;
		color: var(--ink-faint);
		flex-shrink: 0;
	}
	.mmenu {
		/* Positioned by use:anchor; fixed so .mbody's overflow can't clip it. */
		position: fixed;
		z-index: 40;
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		box-shadow: var(--shadow);
		overflow-y: auto;
		overscroll-behavior: contain;
		width: max-content;
		max-width: min(20rem, calc(100vw - 1rem));
	}
	.mopt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		font: inherit;
		cursor: pointer;
		padding: 0.4rem 0.5rem;
		border-radius: var(--r-sm);
		color: var(--ink);
	}
	.mopt:hover {
		background: var(--accent-soft);
	}
	.mopttext {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mbox {
		display: inline-grid;
		place-items: center;
		width: 16px;
		height: 16px;
		border: 1px solid var(--line);
		border-radius: 4px;
		font-size: 0.7rem;
		color: #fff;
		flex-shrink: 0;
	}
	.mbox.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.mempty {
		padding: 0.4rem 0.5rem;
		font-size: 0.82rem;
		color: var(--ink-faint);
	}
</style>
