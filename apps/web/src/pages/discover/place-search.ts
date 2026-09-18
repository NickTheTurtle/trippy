import type { PlaceHit, PlaceHitDetails } from '../../lib/api-types';

/**
 * The parts of a provider search that both places that run one must agree on.
 *
 * There are two: Discover's add popup, and the schedule's place field. They ask
 * the provider the same question through the same endpoint, and the things
 * below are the ones that cost money or correctness to get wrong: how long
 * typing pauses before a request is sent, what ties a session of typing to the
 * lookup that ends it, and how a details response is merged over the suggestion
 * it belongs to. Two copies of these drift apart quietly, and the bill is the
 * first thing that notices.
 */

/**
 * How long typing must pause before the search is sent.
 *
 * Every send is a billed provider request, so this is a price as much as a
 * feel. At 350ms a normal typist paid for two or three prefixes of the word
 * they were halfway through writing; 600ms is still under the pause you make
 * when you stop to look at a screen, and it usually buys one search per word
 * instead of three.
 */
export const SEARCH_DEBOUNCE_MS = 600;

/**
 * Identifies one search session: everything typed up to the moment a result is
 * picked. Provider suggestions made under a session that ends in a details
 * lookup are not billed, so this token is what makes typing free. `randomUUID`
 * needs a secure context, which the app has, but the fallback keeps a plain-http
 * dev box working rather than throwing halfway through a keystroke.
 */
export function newSessionToken(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Merges a details response over the result it belongs to.
 *
 * Not a plain spread: a suggestion knows its name and address and the details
 * call may not have answered with either, and `{...hit, ...details}` would
 * write those `undefined`s straight over the good values.
 */
export function withDetails(h: PlaceHit, d: PlaceHitDetails): PlaceHit {
	return {
		...h,
		...d,
		name: d.name ?? h.name,
		address: d.address ?? h.address,
		category: d.category || h.category,
		lat: d.lat ?? h.lat,
		lng: d.lng ?? h.lng
	};
}
