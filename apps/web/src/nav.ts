import { copy } from './copy';

/**
 * The five tabs under /trips/:tripId, in the order the tab bar shows them.
 *
 * Discover is first and is the landing tab, which is why /trips/:tripId
 * redirects there rather than to the schedule. The earlier scaffold listed nine
 * sections including Costs and Settings; neither is a tab in the real app.
 * Costs was folded into Preparation, and Settings is the edit dialog in this
 * header, which has no page of its own.
 */
export const TABS = [
	{ slug: 'discover', label: copy.nav.discover },
	{ slug: 'pretrip', label: copy.nav.pretrip },
	{ slug: 'calendar', label: copy.nav.calendar },
	{ slug: 'expenses', label: copy.nav.expenses },
	{ slug: 'people', label: copy.nav.people }
] as const;

/**
 * Sections folded into other tabs. The paths stay valid so old links and
 * bookmarks still land somewhere sensible.
 */
export const MERGED = [
	{ slug: 'costs', into: 'pretrip' },
	{ slug: 'lodging', into: 'discover' }
] as const;
