import { POI_KINDS, isPoiKind, type PoiKind } from '@trippy/core/types';
import { copy } from '../../copy';

/**
 * What the Discover type dropdown offers.
 *
 * Attractions and Food & Drink are buckets of `pois.kind`; Stays reads
 * `lodging_options`, a different table with a nightly price. That difference
 * belongs to the server, not to the reader: someone comparing what a city has
 * to offer is looking at one pool, so **All** shows every kind in one grid and
 * the page no longer treats a stay as a separate mode with its own chrome.
 *
 * The kinds come from `POI_KINDS` in `@trippy/core` rather than being written
 * out here, so the dropdown cannot drift from the column's CHECK constraint.
 */
export const STAY_VIEW = 'stay';
export const ALL_VIEW = 'all';

export type DiscoverView = PoiKind | typeof STAY_VIEW | typeof ALL_VIEW;

/**
 * What a thing can *be*. All is a filter and never a type, since nothing is
 * added without saying which of these it is: the add form takes this, and the
 * dropdown above the grid takes `DiscoverView`.
 */
export type AddType = PoiKind | typeof STAY_VIEW;

const KIND_LABEL: Record<PoiKind, string> = {
	attraction: copy.discover.types.attraction,
	food: copy.discover.types.food
};

export const VIEW_LABEL: Record<DiscoverView, string> = {
	...KIND_LABEL,
	[STAY_VIEW]: copy.discover.types.stay,
	[ALL_VIEW]: copy.discover.types.all
};

/** The types something can be added as, in the order the dropdown lists them. */
export const TYPE_OPTIONS = [
	...POI_KINDS.map((k) => ({ value: k as AddType, label: KIND_LABEL[k] })),
	{ value: STAY_VIEW as AddType, label: VIEW_LABEL[STAY_VIEW] }
];

/** The same list with All in front, for filtering the grid. */
export const VIEW_OPTIONS = [
	{ value: ALL_VIEW as DiscoverView, label: VIEW_LABEL[ALL_VIEW] },
	...TYPE_OPTIONS.map((o) => ({ value: o.value as DiscoverView, label: o.label }))
];

export function isStayView(view: DiscoverView): boolean {
	return view === STAY_VIEW;
}

/** Whether the grid carries stays, which All does alongside everything else. */
export function showsStays(view: DiscoverView): boolean {
	return view === STAY_VIEW || view === ALL_VIEW;
}

/** Which `pois.kind` values the grid carries. Empty while showing stays alone. */
export function placeKinds(view: DiscoverView): PoiKind[] {
	if (view === ALL_VIEW) return [...POI_KINDS];
	return isPoiKind(view) ? [view] : [];
}

/** The type an add starts on. All is not one, so it opens on the first kind. */
export function toAddType(view: DiscoverView): AddType {
	return view === ALL_VIEW ? 'attraction' : view;
}
