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
	const markers = useRef<Gm[]>([]);
	const lines = useRef<Gm[]>([]);
	/** Last icon applied to each marker, so an unchanged one is never re-set. */
	const iconKeys = useRef<string[]>([]);
	/** Bumped once the map exists, so the draw effect below reruns for it. */
	const [ready, setReady] = useState(0);

	// The centre is only read when the map is first created; afterwards the
	// viewport is driven by the pins. Keeping it in a ref stops a new centre
	// object from tearing the map down and rebuilding it.
	const centerRef = useRef(center);
	centerRef.current = center;

	/* The drawing depends on what the tracks *say*, not on the array holding it.
	   Callers build that array inline, so it is a new object on every render:
	   dragging a block on the schedule board re-renders at pointer rate, and a
	   dependency on the array itself redrew the whole map many times a second.
	   That is what made the pins blink. */
	const tracksRef = useRef(tracks);
	tracksRef.current = tracks;
	const sig = JSON.stringify([tracks, center]);

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
			for (const o of markers.current) o.setMap?.(null);
			for (const o of lines.current) o.setMap?.(null);
			markers.current = [];
			lines.current = [];
			iconKeys.current = [];
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

		/* Work out what the map should show, then reconcile the overlays already
		   on it towards that, rather than clearing and rebuilding. A Marker that
		   is removed and replaced flashes; one that is told its new position or
		   icon does not. Renumbering after a reorder is a `setIcon`, which is the
		   common case and is now invisible. */
		type Want = { pos: { lat: number; lng: number }; iconKey: string; icon: Gm; title: string };
		const wantMarkers: Want[] = [];
		const wantLines: { path: { lat: number; lng: number }[]; color: string }[] = [];
		const bounds = new g.maps.LatLngBounds();

		for (const t of tracksRef.current) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const path: { lat: number; lng: number }[] = [];
			located.forEach((i, idx) => {
				const pos = { lat: i.lat as number, lng: i.lng as number };
				path.push(pos);
				bounds.extend(pos);
				wantMarkers.push({
					pos,
					iconKey: t.dot ? `dot:${t.color}` : `pin:${t.color}:${idx + 1}`,
					icon: t.dot ? dotIcon(t.color) : pinIcon(t.color, idx + 1),
					title: t.dot ? i.title : `${i.title} · ${t.name}`
				});
			});
			if (t.line !== false && path.length > 1) wantLines.push({ path, color: t.color });
		}

		wantMarkers.forEach((w, i) => {
			const dot = w.iconKey.startsWith('dot:');
			const m = markers.current[i];
			if (!m) {
				markers.current[i] = new g.maps.Marker({
					position: w.pos,
					map,
					icon: w.icon,
					title: w.title,
					zIndex: dot ? 1 : 10
				});
				iconKeys.current[i] = w.iconKey;
				return;
			}
			const at = m.getPosition();
			if (!at || at.lat() !== w.pos.lat || at.lng() !== w.pos.lng) m.setPosition(w.pos);
			if (iconKeys.current[i] !== w.iconKey) {
				m.setIcon(w.icon);
				m.setZIndex(dot ? 1 : 10);
				iconKeys.current[i] = w.iconKey;
			}
			if (m.getTitle() !== w.title) m.setTitle(w.title);
		});
		for (let i = wantMarkers.length; i < markers.current.length; i++) {
			markers.current[i].setMap(null);
		}
		markers.current.length = wantMarkers.length;
		iconKeys.current.length = wantMarkers.length;

		wantLines.forEach((w, i) => {
			const l = lines.current[i];
			if (!l) {
				lines.current[i] = new g.maps.Polyline({
					path: w.path,
					strokeColor: w.color,
					strokeOpacity: 0.8,
					strokeWeight: 3,
					map
				});
				return;
			}
			l.setPath(w.path);
			l.setOptions({ strokeColor: w.color });
		});
		for (let i = wantLines.length; i < lines.current.length; i++) lines.current[i].setMap(null);
		lines.current.length = wantLines.length;

		const count = wantMarkers.length;
		const c = centerRef.current;
		if (count > 1) {
			map.fitBounds(bounds, 40);
		} else if (count === 1) {
			map.setCenter(bounds.getCenter());
			map.setZoom(14);
		} else if (c?.lat != null && c?.lng != null) {
			map.setCenter({ lat: c.lat, lng: c.lng });
			map.setZoom(12);
		}
	}, [sig, ready]);

	return <div ref={elRef} className="gmapbox" />;
}
