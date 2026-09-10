import { POI_KINDS, isPoiKind, type PoiKind } from '@trippy/core/types';
import { copy } from '../../copy';

/**
 * What the Discover type dropdown offers.
 *
 * Two of the three are buckets of `pois.kind` and filter one list; the third is
 * a view switch onto `lodging_options`, a different table with prices, a lock
 * and one exclusive vote per city. That is why there is no "All": a mixed list
 * would have to render two kinds of card in one grid, and the two do not answer
 * the same question.
 *
 * The kinds come from `POI_KINDS` in `@trippy/core` rather than being written
 * out here, so the dropdown cannot drift from the column's CHECK constraint.
 */
export const STAY_VIEW = 'stay';

export type DiscoverView = PoiKind | typeof STAY_VIEW;

const KIND_LABEL: Record<PoiKind, string> = {
	attraction: copy.discover.types.attraction,
	food: copy.discover.types.food
};

export const VIEW_LABEL: Record<DiscoverView, string> = {
	...KIND_LABEL,
	[STAY_VIEW]: copy.discover.types.stay
};

export const VIEW_OPTIONS = [
	...POI_KINDS.map((k) => ({ value: k as DiscoverView, label: KIND_LABEL[k] })),
	{ value: STAY_VIEW as DiscoverView, label: VIEW_LABEL[STAY_VIEW] }
];

export function isStayView(view: DiscoverView): boolean {
	return view === STAY_VIEW;
}

/** Reads a stored or routed value back into a view, defaulting to Attractions. */
export function toDiscoverView(v: string): DiscoverView {
	return v === STAY_VIEW || isPoiKind(v) ? (v as DiscoverView) : 'attraction';
}
