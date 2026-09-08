<script lang="ts">
	interface Option {
		value: string;
		label: string;
	}

	import { anchor } from '$lib/anchor';

	let {
		options,
		value = $bindable(''),
		name = '',
		placeholder = 'Select…',
		ariaLabel = 'Select',
		compact = false
	}: {
		options: Option[];
		value?: string;
		name?: string;
		placeholder?: string;
		ariaLabel?: string;
		compact?: boolean;
	} = $props();

	let open = $state(false);
	let root: HTMLDivElement;
	let trigger = $state<HTMLButtonElement | undefined>(undefined);

	const selected = $derived(options.find((o) => o.value === value) ?? null);

	function choose(v: string) {
		value = v;
		open = false;
	}
	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') open = false;
	}
</script>

<svelte:window onclick={onWindowClick} />

<div class="sel" class:compact bind:this={root}>
	{#if name}<input type="hidden" {name} {value} />{/if}
	<button
		type="button"
		class="seltrigger"
		bind:this={trigger}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={ariaLabel}
		onclick={() => (open = !open)}
		onkeydown={onKey}
	>
		<span class="sellabel" class:placeholder={!selected}>{selected?.label ?? placeholder}</span>
		<span class="selcaret">▾</span>
	</button>
	{#if open}
		<ul class="selmenu" role="listbox" tabindex="-1" use:anchor={{ trigger }}>
			{#each options as o (o.value)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={o.value === value}
						class="selopt"
						class:on={o.value === value}
						onclick={() => choose(o.value)}
					>
						<span class="selopttext">{o.label}</span>
						{#if o.value === value}<span class="selcheck">✓</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.sel {
		position: relative;
		/* Wide enough to read by default, but never wider than the space it's given;
		   a bare min-width here overflows narrow parents like the modal's field row. */
		min-width: min(9rem, 100%);
	}
	.sel.compact {
		min-width: min(7.5rem, 100%);
	}
	.seltrigger {
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
	.sel.compact .seltrigger {
		padding: 0.35rem 0.5rem;
		font-size: 0.85rem;
	}
	.seltrigger:hover {
		border-color: var(--accent);
	}
	.sellabel {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sellabel.placeholder {
		color: var(--ink-faint);
	}
	.selcaret {
		font-size: 0.7rem;
		color: var(--ink-faint);
		flex-shrink: 0;
	}
	.selmenu {
		/* Positioned by use:anchor; fixed so .mbody's overflow can't clip it. */
		position: fixed;
		z-index: 40;
		width: max-content;
		max-width: min(20rem, calc(100vw - 1rem));
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		box-shadow: var(--shadow);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.selopt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		font: inherit;
		cursor: pointer;
		padding: 0.4rem 0.5rem;
		border-radius: var(--r-sm);
		color: var(--ink);
		white-space: nowrap;
	}
	.selopttext {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.selcheck {
		color: var(--accent-ink);
		font-size: 0.8rem;
		flex: 0 0 auto;
	}
	.selopt:hover {
		background: var(--accent-soft);
	}
	.selopt.on {
		color: var(--accent-ink);
		font-weight: 500;
	}
</style>
