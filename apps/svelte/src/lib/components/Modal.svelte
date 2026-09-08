<script lang="ts">
	import type { Snippet } from 'svelte';
	import { lockScroll } from '$lib/scroll-lock';

	/**
	 * The one dialog used across the app.
	 *
	 * Built on the native <dialog> element via showModal(), which hands us focus
	 * trapping, Escape-to-close, focus restore, background inertness and top-layer
	 * rendering for free: all things the hand-rolled versions were missing, and
	 * the reason this isn't a plain positioned <div>.
	 *
	 * Layout is a flex column: the header and footer stay pinned and only .mbody
	 * scrolls, so a tall dialog produces exactly one scrollbar instead of nesting
	 * its own inside the page's.
	 */
	interface Props {
		open: boolean;
		title: string;
		/** Secondary text beside the title. Truncates rather than pushing the close button off. */
		subtitle?: string;
		/** Small swatch before the title, for colour-coded things like tracks. */
		swatch?: string;
		size?: 'sm' | 'md' | 'lg';
		onclose: () => void;
		children: Snippet;
	}

	let { open, title, subtitle, swatch, size = 'md', onclose, children }: Props = $props();

	let el: HTMLDialogElement | null = $state(null);

	$effect(() => {
		const d = el;
		if (!d) return;
		if (open && !d.open) d.showModal();
		else if (!open && d.open) d.close();
	});

	// The page behind must not scroll with the dialog; without this you get the
	// dialog's scrollbar and the document's side by side. The lock also pads the
	// body by the width the vanishing scrollbar frees up, so the page doesn't
	// jump sideways as the dialog opens.
	$effect(() => {
		if (!open) return;
		return lockScroll();
	});

	/**
	 * Close on backdrop click. A <dialog>'s backdrop is part of the element itself,
	 * so a click on it targets the dialog, but so does a click on our own padding.
	 * Comparing against the border box tells the two apart, and checking mousedown
	 * as well stops a drag that *ends* outside the panel from closing it.
	 */
	let downOutside = false;
	function hitBackdrop(e: MouseEvent, d: HTMLDialogElement) {
		if (e.target !== d) return false;
		const r = d.getBoundingClientRect();
		return (
			e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
		);
	}
</script>

<dialog
	bind:this={el}
	class="modal {size}"
	oncancel={(e) => {
		e.preventDefault();
		onclose();
	}}
	onmousedown={(e) => (downOutside = hitBackdrop(e, e.currentTarget))}
	onclick={(e) => {
		if (downOutside && hitBackdrop(e, e.currentTarget)) onclose();
		downOutside = false;
	}}
>
	{#if open}
		<div class="mhead">
			{#if swatch}<span class="mswatch" style={`background:${swatch}`}></span>{/if}
			<h2 class="mtitle">{title}</h2>
			{#if subtitle}<span class="msub" title={subtitle}>{subtitle}</span>{/if}
			<button type="button" class="mclose" aria-label="Close" onclick={onclose}>
				<svg viewBox="0 0 16 16" aria-hidden="true"
					><path
						d="M4 4l8 8M12 4l-8 8"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/></svg
				>
			</button>
		</div>
		{@render children()}
	{/if}
</dialog>

<style>
	.modal {
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow);
		width: min(var(--mw), calc(100vw - 2rem));
		/* Cap the panel so the body scrolls internally rather than the whole page. */
		max-height: min(86vh, calc(100vh - 3rem));
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.modal.sm {
		--mw: 460px;
	}
	.modal.md {
		--mw: 620px;
	}
	.modal.lg {
		--mw: 860px;
	}
	.modal::backdrop {
		background: rgba(20, 24, 22, 0.45);
		backdrop-filter: blur(2px);
	}

	.mhead {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.95rem 1.15rem;
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
	}
	.mtitle {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 0 1 auto;
	}
	.msub {
		color: var(--ink-faint);
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.mswatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: 0 0 auto;
	}
	.mclose {
		flex: 0 0 auto;
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border: 1px solid transparent;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--ink-soft);
	}
	.mclose svg {
		width: 16px;
		height: 16px;
	}
	.mclose:hover {
		background: var(--surface-2);
		color: var(--ink);
	}

	/* Consumers render these inside the dialog, so they have to be global. */
	:global(.modal .mform) {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}
	:global(.modal .mbody) {
		padding: 1.15rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		min-height: 0;
		flex: 1 1 auto;
	}
	:global(.modal .mfoot) {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
		padding: 0.85rem 1.15rem;
		border-top: 1px solid var(--line);
		background: var(--surface);
		flex: 0 0 auto;
	}
	/* Validation text and the like, pushed away from the buttons. */
	:global(.modal .mfoot .mfoot-note) {
		margin-right: auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	@media (max-width: 620px) {
		.modal {
			max-height: min(94vh, calc(100vh - 1rem));
		}
		:global(.modal .mfoot) {
			justify-content: stretch;
		}
		:global(.modal .mfoot .btn) {
			flex: 1 1 auto;
			justify-content: center;
		}
	}
</style>
