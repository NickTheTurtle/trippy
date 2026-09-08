<script lang="ts">
	import { coverArt, photoSrc } from '@trippy/core/cover';

	/**
	 * Shared cover image for place / stay cards.
	 *
	 * Prefers the place's real photograph: the storefront-style picture Google
	 * Maps shows, and falls back to deterministic generated art when there is
	 * none. A photo that fails at runtime (Google photo references expire) falls
	 * back too, so a card never shows a broken image.
	 */
	let {
		photo = null,
		seed,
		category = null,
		height = '128px'
	}: {
		photo?: string | null;
		seed: string;
		category?: string | null;
		height?: string;
	} = $props();

	const art = $derived(coverArt(seed, category));
	const photoUrl = $derived(photoSrc(photo));

	let failed = $state(false);

	const src = $derived(failed ? null : photoUrl);

	// A new photo deserves a fresh attempt even if the previous one failed.
	$effect(() => {
		void photoUrl;
		failed = false;
	});
</script>

<div class="cover" style={`height:${height};background:${art.background}`}>
	{#if src}
		<img {src} alt="" loading="lazy" decoding="async" onerror={() => (failed = true)} />
	{:else}
		<span class="glyph" aria-hidden="true">{art.glyph}</span>
	{/if}
</div>

<style>
	.cover {
		position: relative;
		display: grid;
		place-items: center;
		overflow: hidden;
		flex: 0 0 auto;
	}
	.cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.glyph {
		font-size: 2.4rem;
		opacity: 0.4;
		filter: saturate(0.35);
	}
</style>
