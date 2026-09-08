<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type Item = { title: string; lat: number | null; lng: number | null };
	type Track = { name: string; color: string; items: Item[]; line?: boolean; dot?: boolean };
	type Center = { lat: number | null; lng: number | null; name: string } | null;

	let {
		tracks = [],
		apiKey,
		center = null
	}: { tracks: Track[]; apiKey: string; center?: Center } = $props();

	let el: HTMLDivElement;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let map: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let g: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let overlays: any[] = [];

	// Load the Maps JS API once per page, shared across instances.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function loadMaps(key: string): Promise<any> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const w = window as any;
		if (w.google?.maps) return Promise.resolve(w.google);
		if (w.__wpMapsPromise) return w.__wpMapsPromise;
		w.__wpMapsPromise = new Promise((resolve, reject) => {
			const s = document.createElement('script');
			s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
			s.async = true;
			s.onload = () => resolve(w.google);
			s.onerror = () => reject(new Error('maps load failed'));
			document.head.appendChild(s);
		});
		return w.__wpMapsPromise;
	}

	function pinIcon(color: string, n: number) {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
			<path d="M14 0C6.3 0 0 6.1 0 13.7 0 24 14 36 14 36s14-12 14-22.3C28 6.1 21.7 0 14 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
			<text x="14" y="18" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#fff">${n}</text>
		</svg>`;
		return {
			url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
			scaledSize: new g.maps.Size(28, 36),
			anchor: new g.maps.Point(14, 36)
		};
	}

	function dotIcon(color: string) {
		return {
			path: g.maps.SymbolPath.CIRCLE,
			scale: 6,
			fillColor: color,
			fillOpacity: 0.9,
			strokeColor: '#fff',
			strokeWeight: 2
		};
	}

	function render() {
		if (!map || !g) return;
		for (const o of overlays) o.setMap(null);
		overlays = [];
		const bounds = new g.maps.LatLngBounds();
		let count = 0;

		for (const t of tracks) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const path: { lat: number; lng: number }[] = [];
			located.forEach((i, idx) => {
				const pos = { lat: i.lat as number, lng: i.lng as number };
				path.push(pos);
				bounds.extend(pos);
				count++;
				const marker = new g.maps.Marker({
					position: pos,
					map,
					icon: t.dot ? dotIcon(t.color) : pinIcon(t.color, idx + 1),
					title: t.dot ? i.title : `${i.title} · ${t.name}`,
					zIndex: t.dot ? 1 : 10
				});
				overlays.push(marker);
			});
			if (t.line !== false && path.length > 1) {
				const line = new g.maps.Polyline({
					path,
					strokeColor: t.color,
					strokeOpacity: 0.8,
					strokeWeight: 3,
					map
				});
				overlays.push(line);
			}
		}

		if (count > 1) {
			map.fitBounds(bounds, 40);
		} else if (count === 1) {
			map.setCenter(bounds.getCenter());
			map.setZoom(14);
		} else if (center?.lat != null && center?.lng != null) {
			map.setCenter({ lat: center.lat, lng: center.lng });
			map.setZoom(12);
		}
	}

	onMount(async () => {
		try {
			g = await loadMaps(apiKey);
		} catch {
			return;
		}
		const start =
			center?.lat != null && center?.lng != null
				? { lat: center.lat, lng: center.lng }
				: { lat: 20, lng: 0 };
		map = new g.maps.Map(el, {
			center: start,
			zoom: center?.lat != null ? 12 : 2,
			mapTypeControl: false,
			streetViewControl: false,
			fullscreenControl: true
		});
		render();
	});

	onDestroy(() => {
		for (const o of overlays) o.setMap?.(null);
		overlays = [];
		map = null;
	});

	// Re-render whenever the visible data changes.
	$effect(() => {
		void tracks;
		void center;
		render();
	});
</script>

<div class="gmapbox" bind:this={el}></div>

<style>
	.gmapbox {
		height: 420px;
		border-radius: var(--r);
		overflow: hidden;
	}
</style>
