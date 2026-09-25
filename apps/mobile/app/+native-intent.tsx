/**
 * Rewrites incoming system links before they become navigation state.
 *
 * On iOS the trip is a set of native tabs, which cannot show the trip's hidden
 * index route; a link to the trip itself (`/trip/{id}`) is therefore sent to
 * its landing tab here, where no navigation has happened yet. Discover is the
 * landing tab, as it is on web and in `app/trip/[tripId]/index.tsx`.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	return path.replace(/(^|\/)trip\/([^/?#]+)\/?(?=[?#]|$)/, '$1trip/$2/discover');
}
