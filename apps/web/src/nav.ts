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
	{ slug: 'preparation', label: copy.nav.preparation },
	{ slug: 'schedule', label: copy.nav.schedule },
	{ slug: 'expenses', label: copy.nav.expenses },
	{ slug: 'people', label: copy.nav.people }
] as const;

/**
 * Paths that are not tabs but still resolve, redirected to the tab that owns
 * them now.
 *
 * Two kinds, handled the same way because a visitor cannot tell them apart.
 * `costs` and `lodging` were folded into the tabs that absorbed them.
 * `calendar` and `pretrip` are the old spellings of tabs whose slug did not
 * match the label above it: the tab read "Schedule" while the URL said
 * calendar, and "Preparation" while the URL said pretrip. A slug is the name of
 * the page as much as the label is, and two names for one page is a thing to
 * explain rather than a thing to read.
 *
 * The redirect is what makes that rename free. Without it the argument for
 * keeping a mismatched slug is real, since a URL's whole job is to keep
 * pointing at what it pointed at; with it, every old link still lands on the
 * page it meant.
 *
 * Note these are the *page* slugs. The API keeps `/trips/:id/pretrip`, which is
 * a different namespace that no one reads off a screen.
 */
export const REDIRECTS = [
	{ from: 'costs', to: 'preparation' },
	{ from: 'lodging', to: 'discover' },
	{ from: 'calendar', to: 'schedule' },
	{ from: 'pretrip', to: 'preparation' }
] as const;
