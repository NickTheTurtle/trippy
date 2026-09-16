import { useEffect, useRef, useState } from 'react';
import { mapCard, createCardLayer } from './map-card';
import MapBoundary from './MapBoundary';

export type MapItem = {
	title: string;
	lat: number | null;
	lng: number | null;
	/** The line under the title: what this is, and when. */
	subtitle?: string;
	/** One short fact per row, under the subtitle. */
	detail?: string[];
	/** A row that reads as a problem rather than a fact, drawn with the warning mark. */
	warn?: string;
};
export type MapTrack = {
	name: string;
	color: string;
	items: MapItem[];
	/**
	 * False to draw pins without joining them up.
	 *
	 * A line between two pins claims that one follows the other, which is the
	 * same claim a number on a pin makes and is false in the same cases: an
	 * unscheduled set of places has no order at all, and a day the group splits
	 * across has one order per group and none overall.
	 */
	line?: boolean;
	/**
	 * False to draw plain pins with nothing written on them. A number on a pin
	 * is a claim about order, so it is only honest when the track has one: a day
	 * whose events overlap is not a sequence, and numbering it would invent one.
	 */
	numbered?: boolean;
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
		__wpMapsReady?: () => void;
		/** The SDK calls this itself when it rejects the key. */
		gm_authFailure?: () => void;
	}
}

/** Why the map is not going to draw. Both mean: use the other renderer. */
export type MapsFailure = 'auth' | 'load';

/**
 * The SDK channel. Pinned rather than left to float, so the app is not
 * rewritten under itself by a release nobody here chose.
 */
const MAPS_VERSION = 'quarterly';
const READY_CALLBACK = '__wpMapsReady';

class MapsError extends Error {
	reason: MapsFailure;
	constructor(reason: MapsFailure) {
		super(`maps ${reason}`);
		this.reason = reason;
	}
}

/* The key being refused is not an error the loader can catch: the script loads
   normally and the SDK reports it later, through a global of its own. It is
   installed once, at import, because it has to exist before the SDK looks for
   it, and it is remembered so a map mounted afterwards is told immediately
   rather than waiting for a second failure that never comes. */
let authFailed = false;
const authWatchers = new Set<() => void>();

if (typeof window !== 'undefined') {
	const previous = window.gm_authFailure;
	window.gm_authFailure = () => {
		authFailed = true;
		for (const watcher of [...authWatchers]) watcher();
		previous?.();
	};
}

function watchAuthFailure(onFailure: () => void): () => void {
	if (authFailed) {
		onFailure();
		return () => {};
	}
	authWatchers.add(onFailure);
	return () => authWatchers.delete(onFailure);
}

/**
 * Waits for the parts of the SDK this component actually uses.
 *
 * This is the fix for the polyline crash, and it is not optional politeness.
 * The bootstrap script defines `google.maps` and then fetches the rest of the
 * SDK in modules. `Polyline` exists from the start but is a shell: the internal
 * `latLngs` it reads is only created when `poly.js` arrives. Constructing one
 * early therefore works, and the first `setPath` on it throws
 * "Cannot read properties of undefined (reading 'setAt')". When the key is
 * refused the SDK stops fetching modules, `poly.js` never arrives, and the
 * shell stays broken for the life of the page. `importLibrary` resolves only
 * once the module is really there.
 */
async function libraries(g: Gm): Promise<Gm> {
	await Promise.all([g.maps.importLibrary('maps'), g.maps.importLibrary('marker')]);
	return g;
}

/**
 * Loads the Maps JS API once per page. The promise is cached on `window` rather
 * than in a module variable so two instances, or a remount under StrictMode,
 * share one <script> instead of racing to append their own.
 */
function loadMaps(key: string): Promise<Gm> {
	if (window.google?.maps?.importLibrary) return libraries(window.google);
	if (window.__wpMapsPromise) return window.__wpMapsPromise;
	window.__wpMapsPromise = new Promise<Gm>((resolve, reject) => {
		window[READY_CALLBACK] = () => {
			libraries(window.google).then(resolve, () => reject(new MapsError('load')));
		};
		const s = document.createElement('script');
		// `loading=async` is what makes the bootstrap hand back through the
		// callback rather than through onload, which is the difference between
		// "the script ran" and "the SDK is usable".
		s.src =
			`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
			`&v=${MAPS_VERSION}&loading=async&callback=${READY_CALLBACK}`;
		s.async = true;
		s.onerror = () => reject(new MapsError('load'));
		document.head.appendChild(s);
	});
	return window.__wpMapsPromise;
}

function GoogleMapInner({
	tracks,
	apiKey,
	center = null,
	onUnavailable
}: {
	tracks: MapTrack[];
	apiKey: string;
	center?: MapCenter;
	/**
	 * Called when this renderer cannot show a map: the script did not load, or
	 * the key was refused. The caller is expected to switch to the keyless
	 * renderer, which is strictly better than an SDK error card.
	 */
	onUnavailable?: (reason: MapsFailure) => void;
}) {
	const elRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<Gm>(null);
	const gRef = useRef<Gm>(null);
	const markers = useRef<Gm[]>([]);
	const lines = useRef<Gm[]>([]);
	/** Last icon applied to each marker, so an unchanged one is never re-set. */
	const iconKeys = useRef<string[]>([]);
	/* One hover card for the whole map, and what each marker should put in it.
	   The card is read out of this ref by index rather than captured in the
	   hover listener, so a marker that keeps its slot through a re-layout shows
	   its new times without its listeners being torn down and rebuilt. */
	const layerRef = useRef<ReturnType<typeof createCardLayer> | null>(null);
	const cards = useRef<{ item: MapItem; track: Pick<MapTrack, 'name' | 'color'> }[]>([]);
	/** Bumped once the map exists, so the draw effect below reruns for it. */
	const [ready, setReady] = useState(0);

	// The centre is only read when the map is first created; afterwards the
	// viewport is driven by the pins. Keeping it in a ref stops a new centre
	// object from tearing the map down and rebuilding it.
	const centerRef = useRef(center);
	centerRef.current = center;

	/* Read through a ref so a caller passing an inline arrow does not retear the
	   map down and reload the SDK on every render. */
	const unavailableRef = useRef(onUnavailable);
	unavailableRef.current = onUnavailable;

	/* The drawing depends on what the tracks *say*, not on the array holding it.
	   Callers build that array inline, so it is a new object on every render:
	   dragging a block on the schedule board re-renders at pointer rate, and a
	   dependency on the array itself redrew the whole map many times a second.
	   That is what made the pins blink. */
	const tracksRef = useRef(tracks);
	tracksRef.current = tracks;
	const sig = JSON.stringify([tracks, center]);

	/* What the camera is allowed to react to: where the pins are, and nothing
	   else about them.
	 *
	 * Refitting on every redraw meant that retitling an event, moving it an hour
	 * or putting somebody else on it threw away the reader's pan and zoom, and
	 * with the board previewing an edit as it is typed that happened on every
	 * keystroke. None of those change where anything is. Coordinates are rounded
	 * to about a metre so that a re-read of the same places, which can differ in
	 * the last float digit, is not a move. */
	const fitSig = JSON.stringify(
		tracks.map((t) => t.items.map((i) => [i.lat?.toFixed(5) ?? null, i.lng?.toFixed(5) ?? null]))
	);
	/** The last set of points the camera was fitted to. */
	const fitted = useRef('');

	useEffect(() => {
		let cancelled = false;
		const report = (reason: MapsFailure) => {
			if (!cancelled) unavailableRef.current?.(reason);
		};
		/* The refusal arrives seconds after the map is built, through the SDK's
		   own global, so it is watched for the whole life of the component rather
		   than awaited here. */
		const stopWatching = watchAuthFailure(() => report('auth'));

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
				// A tap opens a card, so a tap on the map behind it is what puts it away.
				mapRef.current.addListener('click', () => layerRef.current?.hide());
				setReady((n) => n + 1);
			})
			// Swallowed here once, which is how a page with a broken key went on
			// showing the SDK's own error card instead of falling back.
			.catch((err: unknown) => report(err instanceof MapsError ? err.reason : 'load'));

		return () => {
			cancelled = true;
			stopWatching();
			for (const o of markers.current) o.setMap?.(null);
			for (const o of lines.current) o.setMap?.(null);
			layerRef.current?.destroy();
			layerRef.current = null;
			markers.current = [];
			lines.current = [];
			iconKeys.current = [];
			cards.current = [];
			fitted.current = '';
			mapRef.current = null;
		};
	}, [apiKey]);

	useEffect(() => {
		const map = mapRef.current;
		const g = gRef.current;
		if (!map || !g) return;

		const pinIcon = (color: string, n: number | null) => {
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
			<path d="M14 0C6.3 0 0 6.1 0 13.7 0 24 14 36 14 36s14-12 14-22.3C28 6.1 21.7 0 14 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
			${n === null ? '' : `<text x="14" y="18" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#fff">${n}</text>`}
		</svg>`;
			return {
				url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
				scaledSize: new g.maps.Size(28, 36),
				anchor: new g.maps.Point(14, 36)
			};
		};
		/* The card is the shared one, drawn on the app's own layer rather than in
		   the library's bubble, so nothing clips it. */
		const card = (c: { item: MapItem; track: Pick<MapTrack, 'name' | 'color'> }) =>
			mapCard(c.item, c.track);

		/* Work out what the map should show, then reconcile the overlays already
		   on it towards that, rather than clearing and rebuilding. A Marker that
		   is removed and replaced flashes; one that is told its new position or
		   icon does not. Renumbering after a reorder is a `setIcon`, which is the
		   common case and is now invisible. */
		type Want = {
			pos: { lat: number; lng: number };
			iconKey: string;
			icon: Gm;
			card: { item: MapItem; track: Pick<MapTrack, 'name' | 'color'> };
		};
		const wantMarkers: Want[] = [];
		const wantLines: { path: { lat: number; lng: number }[]; color: string }[] = [];
		const bounds = new g.maps.LatLngBounds();

		for (const t of tracksRef.current) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const path: { lat: number; lng: number }[] = [];
			located.forEach((i, idx) => {
				const pos = { lat: i.lat as number, lng: i.lng as number };
				const n = t.numbered === false ? null : idx + 1;
				path.push(pos);
				bounds.extend(pos);
				wantMarkers.push({
					pos,
					iconKey: `pin:${t.color}:${n ?? '-'}`,
					icon: pinIcon(t.color, n),
					card: { item: i, track: t }
				});
			});
			if (t.line !== false && path.length > 1) wantLines.push({ path, color: t.color });
		}

		if (!layerRef.current) layerRef.current = createCardLayer();
		const layer = layerRef.current;

		wantMarkers.forEach((w, i) => {
			cards.current[i] = w.card;
			const m = markers.current[i];
			if (!m) {
				const marker = new g.maps.Marker({
					position: w.pos,
					map,
					icon: w.icon,
					zIndex: 10
				});
				const open = (e: { domEvent?: MouseEvent }) => {
					const c = cards.current[i];
					const at = e?.domEvent;
					if (!c || !at) return;
					layer.show(card(c), at.clientX, at.clientY);
				};
				// On click as well as on hover, because a phone has no hover: a tap is
				// the only way to read a pin there, and the card leaves on the next tap.
				marker.addListener('mouseover', open);
				marker.addListener('click', open);
				marker.addListener('mouseout', () => layer.hide());
				markers.current[i] = marker;
				iconKeys.current[i] = w.iconKey;
				return;
			}
			const at = m.getPosition();
			if (!at || at.lat() !== w.pos.lat || at.lng() !== w.pos.lng) m.setPosition(w.pos);
			if (iconKeys.current[i] !== w.iconKey) {
				m.setIcon(w.icon);
				iconKeys.current[i] = w.iconKey;
			}
		});
		for (let i = wantMarkers.length; i < markers.current.length; i++) {
			markers.current[i].setMap(null);
		}
		/* A pin dropped from under the pointer never fires its `mouseout`, so the
		   card would stand on the page with nothing under it. */
		if (markers.current.length > wantMarkers.length) layer.hide();
		markers.current.length = wantMarkers.length;
		iconKeys.current.length = wantMarkers.length;
		cards.current.length = wantMarkers.length;

		const drawLine = (w: { path: { lat: number; lng: number }[]; color: string }) =>
			new g.maps.Polyline({
				path: w.path,
				strokeColor: w.color,
				strokeOpacity: 0.8,
				strokeWeight: 3,
				map
			});

		wantLines.forEach((w, i) => {
			const l = lines.current[i];
			if (l) {
				/* Belt as well as braces. Waiting for `poly.js` before drawing is
				   the actual fix for the shell polyline whose `setPath` throws, but
				   an overlay is cheap to replace and a throw here happens inside an
				   effect, where it takes the whole page down with it. */
				try {
					l.setPath(w.path);
					l.setOptions({ strokeColor: w.color });
					return;
				} catch {
					l.setMap(null);
				}
			}
			lines.current[i] = drawLine(w);
		});
		for (let i = wantLines.length; i < lines.current.length; i++) lines.current[i].setMap(null);
		lines.current.length = wantLines.length;

		const count = wantMarkers.length;
		const c = centerRef.current;
		// Only when the points themselves have changed. Everything above this
		// redraws on any edit; the camera is the one thing the reader owns.
		if (fitted.current === fitSig) return;
		fitted.current = fitSig;
		if (count > 1) {
			map.fitBounds(bounds, 40);
		} else if (count === 1) {
			map.setCenter(bounds.getCenter());
			map.setZoom(14);
		} else if (c?.lat != null && c?.lng != null) {
			map.setCenter({ lat: c.lat, lng: c.lng });
			map.setZoom(12);
		}
	}, [sig, fitSig, ready]);

	return <div ref={elRef} className="gmapbox" />;
}

/**
 * The map, fenced. Every caller gets the boundary without asking, because the
 * caller that forgets is the one that takes its page down.
 */
export default function GoogleMap(props: Parameters<typeof GoogleMapInner>[0]) {
	return (
		<MapBoundary>
			<GoogleMapInner {...props} />
		</MapBoundary>
	);
}
