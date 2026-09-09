import { useEffect, useRef, useState } from 'react';

export type MapItem = { title: string; lat: number | null; lng: number | null };
export type MapTrack = {
	name: string;
	color: string;
	items: MapItem[];
	/** False to draw pins without joining them up (used for unscheduled places). */
	line?: boolean;
	/** True to draw small dots rather than numbered pins. */
	dot?: boolean;
};
export type MapCenter = {
	lat: number | null;
	lng: number | null;
	name: string;
} | null;

/* The Maps JS API has no types here, and pulling in @types/google.maps for one
   component is more surface than it is worth. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Gm = any;

declare global {
	interface Window {
		google?: Gm;
		__wpMapsPromise?: Promise<Gm>;
	}
}

/**
 * Loads the Maps JS API once per page. The promise is cached on `window` rather
 * than in a module variable so two instances, or a remount under StrictMode,
 * share one <script> instead of racing to append their own.
 */
function loadMaps(key: string): Promise<Gm> {
	if (window.google?.maps) return Promise.resolve(window.google);
	if (window.__wpMapsPromise) return window.__wpMapsPromise;
	window.__wpMapsPromise = new Promise<Gm>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
		s.async = true;
		s.onload = () => resolve(window.google);
		s.onerror = () => reject(new Error('maps load failed'));
		document.head.appendChild(s);
	});
	return window.__wpMapsPromise;
}

export default function GoogleMap({
	tracks,
	apiKey,
	center = null
}: {
	tracks: MapTrack[];
	apiKey: string;
	center?: MapCenter;
}) {
	const elRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<Gm>(null);
	const gRef = useRef<Gm>(null);
	const overlays = useRef<Gm[]>([]);
	/** Bumped once the map exists, so the draw effect below reruns for it. */
	const [ready, setReady] = useState(0);

	// The centre is only read when the map is first created; afterwards the
	// viewport is driven by the pins. Keeping it in a ref stops a new centre
	// object from tearing the map down and rebuilding it.
	const centerRef = useRef(center);
	centerRef.current = center;

	useEffect(() => {
		let cancelled = false;
		loadMaps(apiKey)
			.then((g: Gm) => {
				if (cancelled || !elRef.current) return;
				const c = centerRef.current;
				gRef.current = g;
				mapRef.current = new g.maps.Map(elRef.current, {
					center:
						c?.lat != null && c?.lng != null ? { lat: c.lat, lng: c.lng } : { lat: 20, lng: 0 },
					zoom: c?.lat != null ? 12 : 2,
					mapTypeControl: false,
					streetViewControl: false,
					fullscreenControl: true
				});
				setReady((n) => n + 1);
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			for (const o of overlays.current) o.setMap?.(null);
			overlays.current = [];
			mapRef.current = null;
		};
	}, [apiKey]);

	useEffect(() => {
		const map = mapRef.current;
		const g = gRef.current;
		if (!map || !g) return;

		const pinIcon = (color: string, n: number) => {
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
			<path d="M14 0C6.3 0 0 6.1 0 13.7 0 24 14 36 14 36s14-12 14-22.3C28 6.1 21.7 0 14 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
			<text x="14" y="18" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#fff">${n}</text>
		</svg>`;
			return {
				url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
				scaledSize: new g.maps.Size(28, 36),
				anchor: new g.maps.Point(14, 36)
			};
		};
		const dotIcon = (color: string) => ({
			path: g.maps.SymbolPath.CIRCLE,
			scale: 6,
			fillColor: color,
			fillOpacity: 0.9,
			strokeColor: '#fff',
			strokeWeight: 2
		});

		for (const o of overlays.current) o.setMap(null);
		overlays.current = [];
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
				overlays.current.push(
					new g.maps.Marker({
						position: pos,
						map,
						icon: t.dot ? dotIcon(t.color) : pinIcon(t.color, idx + 1),
						title: t.dot ? i.title : `${i.title} · ${t.name}`,
						zIndex: t.dot ? 1 : 10
					})
				);
			});
			if (t.line !== false && path.length > 1) {
				overlays.current.push(
					new g.maps.Polyline({
						path,
						strokeColor: t.color,
						strokeOpacity: 0.8,
						strokeWeight: 3,
						map
					})
				);
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
	}, [tracks, center, ready]);

	return <div ref={elRef} className="gmapbox" />;
}
