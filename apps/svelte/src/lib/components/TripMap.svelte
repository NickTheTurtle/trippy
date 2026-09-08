<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import 'leaflet/dist/leaflet.css';
	import type { Map as LMap, Layer } from 'leaflet';

	type Item = { title: string; lat: number | null; lng: number | null };
	type Track = { name: string; color: string; items: Item[] };

	let { tracks = [] }: { tracks: Track[] } = $props();

	let el: HTMLDivElement;
	let map: LMap | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let L: any = null;
	let overlays: Layer[] = [];

	function pin(color: string, n: number) {
		return L.divIcon({
			className: 'wp-pin',
			html: `<span style="--pin:${color}"><b>${n}</b></span>`,
			iconSize: [24, 24],
			iconAnchor: [12, 24],
			popupAnchor: [0, -22]
		});
	}

	function render() {
		if (!map || !L) return;
		for (const o of overlays) o.remove();
		overlays = [];
		const pts: [number, number][] = [];

		for (const t of tracks) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const line: [number, number][] = [];
			located.forEach((i, idx) => {
				const ll: [number, number] = [i.lat as number, i.lng as number];
				line.push(ll);
				pts.push(ll);
				const m = L.marker(ll, { icon: pin(t.color, idx + 1) }).bindPopup(
					`<strong>${i.title}</strong><br><span style="color:#4a5551">${t.name}</span>`
				);
				m.addTo(map);
				overlays.push(m);
			});
			if (line.length > 1) {
				const pl = L.polyline(line, {
					color: t.color,
					weight: 3,
					opacity: 0.7,
					dashArray: '6 6'
				}).addTo(map);
				overlays.push(pl);
			}
		}

		if (pts.length === 1) {
			map.setView(pts[0], 14);
		} else if (pts.length > 1) {
			map.fitBounds(L.latLngBounds(pts).pad(0.25));
		}
	}

	onMount(async () => {
		L = (await import('leaflet')).default;
		map = L.map(el, { zoomControl: true, attributionControl: true }).setView([39.9163, 116.3972], 12);
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			attribution: '&copy; OpenStreetMap'
		}).addTo(map);
		render();
	});

	onDestroy(() => {
		if (map) {
			map.remove();
			map = null;
		}
	});

	// Re-render pins whenever the day/track data changes.
	$effect(() => {
		void tracks;
		render();
	});

	const hasPoints = $derived(tracks.some((t) => t.items.some((i) => i.lat != null && i.lng != null)));
</script>

<div class="mapbox" bind:this={el}></div>
{#if !hasPoints}
	<p class="nogeo muted">Schedule places with locations to see them on the map.</p>
{/if}

<style>
	.mapbox {
		height: 260px;
		border-radius: var(--r);
		overflow: hidden;
		z-index: 0;
	}
	.nogeo {
		font-size: 0.82rem;
		margin: 0.6rem 0 0;
	}
	:global(.wp-pin span) {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50% 50% 50% 0;
		transform: rotate(-45deg);
		background: var(--pin, #2f6d5e);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
		border: 2px solid #fff;
	}
	:global(.wp-pin span b) {
		transform: rotate(45deg);
		color: #fff;
		font: 600 0.75rem/1 var(--font, sans-serif);
	}
</style>
