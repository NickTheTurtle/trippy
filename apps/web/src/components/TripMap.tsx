import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Map as LMap, Layer } from 'leaflet';
import type { MapCenter, MapTrack } from './GoogleMap';
import { mapCard, cardAnchor, createCardLayer } from './map-card';
import { groupColocated } from './map-groups';
import MapBoundary from './MapBoundary';

/**
 * The keyless fallback map, on OpenStreetMap tiles.
 *
 * Used when no Google Maps key is configured, and when the configured one is
 * refused: a key the SDK rejects is worse than no key at all, because it buys
 * an error card where this draws an actual map. Leaflet is imported dynamically
 * so a deployment with a working key never pays for the library.
 */
function TripMapInner({
	tracks,
	center = null,
	focus = null,
	focusKey = 0,
	onAdd
}: {
	tracks: MapTrack[];
	center?: MapCenter;
	focus?: MapCenter;
	focusKey?: number;
	/** Schedules a saved place a pin stands for. See `MapItem.addId`. */
	onAdd?: (poiId: string) => void;
}) {
	const elRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<LMap | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const lRef = useRef<any>(null);
	const overlays = useRef<Layer[]>([]);
	const layerRef = useRef<ReturnType<typeof createCardLayer> | null>(null);
	// Held in a ref so the map is built once and only the pins are redrawn.
	const tracksRef = useRef(tracks);
	tracksRef.current = tracks;
	/** The last set of points the camera was fitted to. */
	const fitted = useRef('');
	/* The whole-day bounds, kept fresh on every draw so a cleared focus can put
	   the camera back without recomputing them. */
	const dayPts = useRef<[number, number][]>([]);

	/* Read when the map is built, and again only when there is nothing to fit
	   to. Held in a ref so a new centre object does not rebuild the map. */
	const centerRef = useRef(center);
	centerRef.current = center;
	/** The camera aim, in a ref so `draw` can honour it without depending on it. */
	const focusRef = useRef(focus);
	focusRef.current = focus;
	/* Read at click time rather than captured, so a card built on an earlier
	   draw still calls the handler this render has. */
	const addRef = useRef(onAdd);
	addRef.current = onAdd;

	function draw() {
		const map = mapRef.current;
		const L = lRef.current;
		if (!map || !L) return;

		for (const o of overlays.current) o.remove();
		overlays.current = [];
		const pts: [number, number][] = [];

		// Built as DOM rather than as an HTML string. Track colours come back from
		// the API as member-editable text, so interpolating one into markup would
		// let a crew name a colour that closes the attribute and injects tags.
		// A pin standing for several things carries the count in a badge beside
		// it, not in its body: the body is where the order number goes, and a
		// count written there would be read as one.
		const pin = (color: string, n: number | null, count: number) => {
			const wrap = document.createElement('span');
			wrap.className = 'wp-pin-body';
			wrap.style.setProperty('--pin', color);
			const b = document.createElement('b');
			b.textContent = n === null ? '' : String(n);
			wrap.appendChild(b);
			if (count < 2) {
				return L.divIcon({
					className: 'wp-pin',
					html: wrap,
					iconSize: [24, 24],
					iconAnchor: [12, 24],
					popupAnchor: [0, -22]
				});
			}
			const holder = document.createElement('span');
			holder.className = 'wp-pin-stack';
			holder.appendChild(wrap);
			const badge = document.createElement('i');
			badge.className = 'wp-pin-count';
			badge.style.setProperty('--pin', color);
			badge.textContent = count > 99 ? '99+' : String(count);
			holder.appendChild(badge);
			return L.divIcon({
				className: 'wp-pin',
				html: holder,
				iconSize: [24, 24],
				iconAnchor: [12, 24],
				popupAnchor: [0, -22]
			});
		};

		// Same reasoning as `pin`: the lines on the card are typed by trip members,
		// so it is built as DOM. `mapCard` is shared with the Google map, so the
		// two say the same thing in the same shape.
		if (!layerRef.current) layerRef.current = createCardLayer();
		const layer = layerRef.current;
		/* Every overlay is rebuilt here, so a pin removed under the pointer will
		   never fire its `mouseout`. The card would then stand on the page with
		   nothing under it until the next hover. A held card goes too: its pin is
		   about to be replaced. */
		layer.hide(true);

		for (const t of tracksRef.current) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const line: [number, number][] = [];
			for (const i of located) {
				const ll: [number, number] = [i.lat as number, i.lng as number];
				line.push(ll);
				pts.push(ll);
			}
			/* One pin per point rather than one per item, so several things at one
			   address stop hiding under each other. The line still runs through
			   every item in order: it is the route, and a route can return to a
			   venue it has already visited. */
			for (const p of groupColocated(t.items)) {
				const count = p.items.length;
				const n = t.numbered === false || count > 1 ? null : p.index;
				const title = p.items.map((i) => i.title).join(', ');
				// The pin's own colour wins over the track's, so a track whose stops
				// are different kinds of place draws each in the board's palette; the
				// line stays the track colour. Co-located items take the first's.
				const color = p.items[0]?.color ?? t.color;
				const m = L.marker([p.lat, p.lng], {
					icon: pin(color, n, count),
					// The pin's accessible name, and what a keyboard reader lands on.
					title,
					alt: title
				});
				// Drawn on the app's own layer rather than in Leaflet's popup, so a
				// pin near an edge is not clipped by the map box. On click as well as
				// on hover, because a phone has no hover: a tap is the only way to
				// read a pin there, and the card leaves on the next tap. A clicked
				// card is held open, so a pin holding several things can be read and
				// scrolled without the pointer having to stay on the pin.
				const open = (e: { originalEvent?: MouseEvent }, hold = false) => {
					const at = cardAnchor(e?.originalEvent, m.getElement());
					layer.show(
						mapCard(p.items, t, (id) => addRef.current?.(id)),
						at.x,
						at.y,
						hold
					);
				};
				m.on('mouseover', (e: { originalEvent?: MouseEvent }) => open(e));
				m.on('click', (e: { originalEvent?: MouseEvent }) => open(e, true));
				m.on('mouseout', () => layer.hide());
				m.addTo(map);
				overlays.current.push(m);
			}
			if (t.line !== false && line.length > 1) {
				overlays.current.push(
					L.polyline(line, {
						color: t.color,
						weight: 3,
						opacity: 0.7,
						dashArray: '6 6'
					}).addTo(map)
				);
			}
		}

		dayPts.current = pts;
		if (pts.length === 0) return;
		// A focused pin owns the camera: a redraw must not yank it back to the
		// whole day while the reader is looking at one place.
		if (focusRef.current?.lat != null && focusRef.current?.lng != null) return;
		/* The camera is the reader's. It follows the points when they change and
		   is left alone otherwise, so retitling an event or nudging it an hour
		   does not throw away a pan: none of that moves anything. Rounded so a
		   re-read of the same coordinates does not read as a move. */
		const where = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|');
		if (where === fitted.current) return;
		fitted.current = where;
		if (pts.length === 1) map.setView(pts[0], 14);
		else map.fitBounds(L.latLngBounds(pts).pad(0.25));
	}

	useEffect(() => {
		let cancelled = false;
		let ro: ResizeObserver | null = null;
		import('leaflet').then((mod) => {
			if (cancelled || !elRef.current) return;
			const L = mod.default;
			lRef.current = L;
			const c = centerRef.current;
			/* The city the page is looking at, or the whole world. It used to be a
			   hardcoded pair of coordinates in Beijing, which is a real place to
			   be told your empty trip is. */
			const map = L.map(elRef.current, {
				zoomControl: true,
				attributionControl: true
			}).setView(
				c?.lat != null && c?.lng != null ? [c.lat, c.lng] : [20, 0],
				c?.lat != null ? 12 : 2
			);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				attribution: '&copy; OpenStreetMap'
			}).addTo(map);
			// A tap opens a card, so a tap on the map behind it is what puts it away.
			map.on('click', () => layerRef.current?.hide(true));
			mapRef.current = map;
			draw();
			/* Leaflet reads the size of its container once and caches it, so a box
			   that is sized from the page rather than from a stylesheet, as the
			   schedule's is, leaves it drawing into a size that no longer exists:
			   tiles short of the bottom edge and a centre that is no longer the
			   centre. It has to be told. `invalidateSize` keeps the centre where
			   the reader left it and only fills in what the new size exposes. */
			ro = new ResizeObserver(() => map.invalidateSize({ animate: false }));
			ro.observe(elRef.current);
		});

		return () => {
			cancelled = true;
			ro?.disconnect();
			overlays.current = [];
			layerRef.current?.destroy();
			layerRef.current = null;
			mapRef.current?.remove();
			mapRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/* Redrawn on what the tracks say, not on the array holding it: callers build
	   that inline, so it is a new object on every render and the board renders at
	   pointer rate while a block is dragged. */
	const sig = JSON.stringify(tracks);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(draw, [sig]);

	/* Aim the camera at one pin when the page asks, and put it back on the whole
	   day when the ask clears. Keyed on `focusKey`, which the page changes on
	   every open and every close, so clicking the same block twice still re-aims
	   and closing the dialog zooms back out. The fit-to-day branch reuses the
	   points the last draw measured, so the two cannot disagree. */
	useEffect(() => {
		const map = mapRef.current;
		const L = lRef.current;
		if (!map || !L) return;
		if (focus?.lat != null && focus?.lng != null) {
			map.setView([focus.lat, focus.lng], 16);
			return;
		}
		const pts = dayPts.current;
		if (pts.length === 1) map.setView(pts[0], 14);
		else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focusKey]);

	return <div ref={elRef} className="mapbox" />;
}

/** Fenced for the same reason the Google one is: see `MapBoundary`. */
export default function TripMap(props: Parameters<typeof TripMapInner>[0]) {
	return (
		<MapBoundary>
			<TripMapInner {...props} />
		</MapBoundary>
	);
}
