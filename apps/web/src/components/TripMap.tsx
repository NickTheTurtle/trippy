import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Map as LMap, Layer } from 'leaflet';
import type { MapTrack } from './GoogleMap';
import { mapCard, createCardLayer } from './map-card';
import { copy } from '../copy';

/**
 * The keyless fallback map, on OpenStreetMap tiles.
 *
 * Used when no Google Maps key is configured. Leaflet is imported dynamically so
 * a deployment with a key never pays for the library.
 */
export default function TripMap({ tracks }: { tracks: MapTrack[] }) {
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
		const pin = (color: string, n: number | null) => {
			const wrap = document.createElement('span');
			wrap.style.setProperty('--pin', color);
			const b = document.createElement('b');
			b.textContent = n === null ? '' : String(n);
			wrap.appendChild(b);
			return L.divIcon({
				className: 'wp-pin',
				html: wrap,
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
		   nothing under it until the next hover. */
		layer.hide();

		for (const t of tracksRef.current) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const line: [number, number][] = [];
			located.forEach((i, idx) => {
				const ll: [number, number] = [i.lat as number, i.lng as number];
				line.push(ll);
				pts.push(ll);
				const m = L.marker(ll, {
					icon: pin(t.color, t.numbered === false ? null : idx + 1)
				});
				// Drawn on the app's own layer rather than in Leaflet's popup, so a
				// pin near an edge is not clipped by the map box. On click as well as
				// on hover, because a phone has no hover: a tap is the only way to
				// read a pin there, and the card leaves on the next tap.
				const open = (e: { originalEvent: MouseEvent }) =>
					layer.show(mapCard(i, t), e.originalEvent.clientX, e.originalEvent.clientY);
				m.on('mouseover', open);
				m.on('click', open);
				m.on('mouseout', () => layer.hide());
				m.addTo(map);
				overlays.current.push(m);
			});
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

		if (pts.length === 0) return;
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
		import('leaflet').then((mod) => {
			if (cancelled || !elRef.current) return;
			const L = mod.default;
			lRef.current = L;
			const map = L.map(elRef.current, {
				zoomControl: true,
				attributionControl: true
			}).setView([39.9163, 116.3972], 12);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				attribution: '&copy; OpenStreetMap'
			}).addTo(map);
			// A tap opens a card, so a tap on the map behind it is what puts it away.
			map.on('click', () => layerRef.current?.hide());
			mapRef.current = map;
			draw();
		});

		return () => {
			cancelled = true;
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

	const hasPoints = tracks.some((t) => t.items.some((i) => i.lat != null && i.lng != null));

	return (
		<>
			<div ref={elRef} className="mapbox" />
			{!hasPoints && <p className="nogeo muted">{copy.ui.tripMap.noPoints}</p>}
		</>
	);
}
