<script lang="ts">
	/**
	 * Vertical section switcher for pages that hold several related panels
	 * (Preparation, Expenses). Sibling of the tab strip: tabs move you between
	 * features, this moves you within one.
	 *
	 * Collapses to a horizontal scroller on narrow screens so it never eats the
	 * content column.
	 */
	export interface SectionItem {
		id: string;
		label: string;
		/** Optional right-aligned count. `null` renders nothing. */
		badge?: string | number | null;
	}

	let {
		items,
		value = $bindable(),
		ariaLabel = 'Sections'
	}: {
		items: SectionItem[];
		value: string;
		ariaLabel?: string;
	} = $props();
</script>

<nav class="secnav" aria-label={ariaLabel}>
	{#each items as it (it.id)}
		<button
			type="button"
			class="sec"
			class:on={value === it.id}
			aria-current={value === it.id ? 'true' : undefined}
			onclick={() => (value = it.id)}
		>
			<span class="lbl">{it.label}</span>
			{#if it.badge !== null && it.badge !== undefined && it.badge !== ''}
				<span class="badge">{it.badge}</span>
			{/if}
		</button>
	{/each}
</nav>

<style>
	.secnav {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		position: sticky;
		top: 84px;
	}
	.sec {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		text-align: left;
		background: none;
		border: 1px solid transparent;
		border-radius: var(--r);
		padding: 0.5rem 0.7rem;
		font: inherit;
		font-size: 0.92rem;
		font-weight: 500;
		color: var(--ink-soft);
		cursor: pointer;
		min-width: 0;
	}
	.sec:hover {
		background: var(--surface-2);
		color: var(--ink);
	}
	.sec.on {
		background: var(--surface);
		border-color: var(--line);
		color: var(--accent-ink);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
	}
	.lbl {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.badge {
		flex: 0 0 auto;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--ink-faint);
		font-variant-numeric: tabular-nums;
	}
	.sec.on .badge {
		color: var(--accent);
	}

	@media (max-width: 860px) {
		.secnav {
			flex-direction: row;
			position: static;
			overflow-x: auto;
			scrollbar-width: none;
			padding-bottom: 0.2rem;
			border-bottom: 1px solid var(--line);
			margin-bottom: 1rem;
		}
		.secnav::-webkit-scrollbar {
			display: none;
		}
		.sec {
			width: auto;
			flex: 0 0 auto;
		}
	}
</style>
