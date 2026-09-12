import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Map as LMap, Layer } from 'leaflet';
import type { MapTrack } from './GoogleMap';
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
	// Held in a ref so the map is built once and only the pins are redrawn.
	const tracksRef = useRef(tracks);
	tracksRef.current = tracks;

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

		// Same reasoning as `pin`: the title and the lines under it are typed by
		// trip members, so they are set as text and never parsed as HTML.
		const popup = (title: string, lines: string[]) => {
			const wrap = document.createElement('div');
			wrap.className = 'mapcard';
			const strong = document.createElement('strong');
			strong.textContent = title;
			wrap.appendChild(strong);
			for (const line of lines) {
				const span = document.createElement('span');
				span.textContent = line;
				wrap.appendChild(span);
			}
			return wrap;
		};

		for (const t of tracksRef.current) {
			const located = t.items.filter((i) => i.lat != null && i.lng != null);
			const line: [number, number][] = [];
			located.forEach((i, idx) => {
				const ll: [number, number] = [i.lat as number, i.lng as number];
				line.push(ll);
				pts.push(ll);
				const m = L.marker(ll, {
					icon: pin(t.color, t.numbered === false ? null : idx + 1)
				}).bindPopup(popup(i.title, [...(i.detail ?? []), t.name]));
				// Hovering is enough, the same as on the Google map. The popup still
				// opens on click, so it survives a tap.
				m.on('mouseover', () => m.openPopup());
				m.on('mouseout', () => m.closePopup());
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

		if (pts.length === 1) map.setView(pts[0], 14);
		else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
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
			mapRef.current = map;
			draw();
		});

		return () => {
			cancelled = true;
			overlays.current = [];
			mapRef.current?.remove();
			mapRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(draw, [tracks]);

	const hasPoints = tracks.some((t) => t.items.some((i) => i.lat != null && i.lng != null));

	return (
		<>
			<div ref={elRef} className="mapbox" />
			{!hasPoints && <p className="nogeo muted">{copy.ui.tripMap.noPoints}</p>}
		</>
	);
}
