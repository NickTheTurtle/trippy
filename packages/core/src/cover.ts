/**
 * Cover art for place / stay cards.
 *
 * Most places have no photo of their own: the keyless OSM provider returns none,
 * and Google has no picture for plenty of small venues. An empty grey box for
 * that case looks broken, so the fallback is a deterministic generated cover:
 * the same place always gets the same colours and glyph, which makes cards
 * recognisable at a glance and stable across reloads.
 */

/** Stable 32-bit hash. Deterministic across reloads and machines, unlike hashCode-by-chance. */
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Muted, desaturated pairs that sit behind dark text without fighting the page. */
const PALETTES = [
	['#dfe8e0', '#b9cfc2'],
	['#e8e0d4', '#d3c3a9'],
	['#dde3ec', '#bccadd'],
	['#ecdedd', '#d8bcbb'],
	['#e2e5d6', '#c6ccae'],
	['#e0dcea', '#c3bcda'],
	['#dae7e9', '#b4cdd2'],
	['#ece2d2', '#dbc6a4']
];

const GLYPHS: Record<string, string> = {
	stay: '🛏',
	hotel: '🛏',
	lodging: '🛏',
	food: '🍽',
	restaurant: '🍽',
	cafe: '☕',
	nightlife: '🍸',
	nature: '🌿',
	park: '🌿',
	history: '🏛',
	sights: '📍',
	museum: '🏛',
	shopping: '🛍',
	beach: '🏖',
	activity: '🎯',
	flight: '✈'
};

export interface Cover {
	/** `background` shorthand for the placeholder. */
	background: string;
	/** A single emoji hinting at the category. */
	glyph: string;
}

export function coverArt(seed: string, category?: string | null): Cover {
	const h = hash(seed || 'place');
	const [a, b] = PALETTES[h % PALETTES.length];
	const angle = 100 + ((h >> 8) % 80);
	return {
		background: `linear-gradient(${angle}deg, ${a}, ${b})`,
		glyph: GLYPHS[(category ?? '').trim().toLowerCase()] ?? '📍'
	};
}

/**
 * Resolves a stored `photo` value to something an `<img>` can load. Google photo
 * resource names go through our proxy (which holds the API key); anything else
 * is already a URL. Returns null when there is no usable image.
 */
export function photoSrc(photo: string | null | undefined, width = 640): string | null {
	if (!photo) return null;
	if (photo.startsWith('places/')) {
		return `/api/place-photo?name=${encodeURIComponent(photo)}&w=${width}`;
	}
	return /^https?:\/\//.test(photo) ? photo : null;
}
