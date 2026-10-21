/**
 * Camera arithmetic for the Google map: where a fit lands, and the path there.
 *
 * Google's `fitBounds`, `setCenter` and `setZoom` all jump. Changing day used
 * to cut the map from one framing to the next, and then the tiles of the new
 * one loaded in under the reader, which is the "janky" of the report. The SDK
 * has no animated fit, so the page computes the fit itself and flies the
 * camera there with `moveCamera`, one frame at a time.
 *
 * Everything here is Web Mercator in world units, where the whole world is one
 * unit across at zoom 0 and `256 * 2^zoom` pixels across at any other. It is
 * pure, so it is the same answer whatever the map is doing.
 */

export type Camera = { lat: number; lng: number; zoom: number };

const TILE = 256;
/** Mercator's own limit: past this the projection runs off to infinity. */
const MAX_LAT = 85.05112878;

function clampLat(lat: number): number {
	return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Longitude and latitude to world units, 0..1 on both axes. */
function project(lat: number, lng: number): { x: number; y: number } {
	const s = Math.sin((clampLat(lat) * Math.PI) / 180);
	return {
		x: (lng + 180) / 360,
		y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
	};
}

function unproject(x: number, y: number): { lat: number; lng: number } {
	const wrapped = x - Math.floor(x);
	const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
	return { lat, lng: wrapped * 360 - 180 };
}

/**
 * The camera `fitBounds(bounds, padding)` would choose, without moving to it.
 *
 * The centre is the middle of the box in projected space, which is where
 * Google puts it, not the middle in degrees. The zoom is fractional: the map is
 * built with `isFractionalZoomEnabled` so a flight can pass through every value
 * on the way rather than stepping, and a fit is then as tight as the padding
 * allows instead of rounding down to the next whole level. Null when the box
 * has no room inside its padding to fit anything, for the caller to fall back
 * to the SDK's own fit.
 */
export function fitCamera(
	sw: { lat: number; lng: number },
	ne: { lat: number; lng: number },
	width: number,
	height: number,
	padding: number,
	maxZoom = 21
): Camera | null {
	const w = width - 2 * padding;
	const h = height - 2 * padding;
	if (w <= 0 || h <= 0) return null;
	const a = project(sw.lat, sw.lng);
	const b = project(ne.lat, ne.lng);
	// A box that crosses the antimeridian has its east edge west of its west.
	let dx = b.x - a.x;
	if (dx < 0) dx += 1;
	const dy = Math.abs(a.y - b.y);
	const fits = [
		dx > 0 ? Math.log2(w / (TILE * dx)) : maxZoom,
		dy > 0 ? Math.log2(h / (TILE * dy)) : maxZoom
	];
	const zoom = Math.max(0, Math.min(maxZoom, ...fits));
	const c = unproject(a.x + dx / 2, (a.y + b.y) / 2);
	return { lat: c.lat, lng: c.lng, zoom };
}

/**
 * The path from one camera to another, as a function of progress 0..1.
 *
 * The smooth zoom-and-pan of van Wijk and Nuij ("Smooth and efficient zooming
 * and panning", 2003), the same curve Mapbox's `flyTo` uses. A move within
 * the view is close to a plain pan with the zoom eased across it; a move
 * further than the view can hold (another city) climbs out until both ends are
 * on screen, crosses, and comes back down, so the reader sees where the map
 * went rather than a blur of tiles. `view` is the larger side of the map in
 * pixels, which is what "on screen" is measured against.
 *
 * Also returns `span`, the length of the path in the curve's own units, which
 * the caller uses to give a long flight a little longer.
 */
export function flight(
	from: Camera,
	to: Camera,
	view: number
): { at: (k: number) => Camera; span: number } {
	const rho = 1.42;
	const rho2 = rho * rho;
	const scale = TILE * 2 ** from.zoom;
	const p0 = project(from.lat, from.lng);
	const p1 = project(to.lat, to.lng);
	// The short way round, so Tokyo to Honolulu does not cross Europe.
	let dxw = p1.x - p0.x;
	if (dxw > 0.5) dxw -= 1;
	if (dxw < -0.5) dxw += 1;
	const dx = dxw * scale;
	const dy = (p1.y - p0.y) * scale;
	const u1 = Math.hypot(dx, dy);
	const w0 = Math.max(1, view);
	const w1 = w0 / 2 ** (to.zoom - from.zoom);

	const along = (u: number): Camera => {
		const c = unproject(p0.x + dxw * u, p0.y + (p1.y - p0.y) * u);
		return { lat: c.lat, lng: c.lng, zoom: from.zoom };
	};

	const r = (i: 0 | 1) => {
		const b =
			(w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1);
		return Math.log(Math.sqrt(b * b + 1) - b);
	};

	if (u1 > 1e-6) {
		const r0 = r(0);
		const span = (r(1) - r0) / rho;
		if (Number.isFinite(span) && span > 0) {
			return {
				span,
				at: (k) => {
					if (k >= 1) return to;
					const s = k * span;
					const w = Math.cosh(r0) / Math.cosh(r0 + rho * s);
					const u = (w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / rho2)) / u1;
					return { ...along(u), zoom: from.zoom + Math.log2(1 / w) };
				}
			};
		}
	}
	// Nowhere to travel, only a zoom: ease it, and drift the centre straight.
	const span = Math.abs(Math.log(w1 / w0)) / rho;
	return {
		span,
		at: (k) => (k >= 1 ? to : { ...along(k), zoom: from.zoom + (to.zoom - from.zoom) * k })
	};
}

/** Slow in, slow out: a camera that starts and stops like a hand moved it. */
export function easeInOut(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * How long a flight takes. Around 600ms for a move across the day's own pins,
 * up to 900ms for a jump between cities, which climbs far enough that the
 * shorter time made it a lurch.
 */
export function flightMs(span: number): number {
	return Math.round(Math.min(900, Math.max(500, 480 + 70 * span)));
}
