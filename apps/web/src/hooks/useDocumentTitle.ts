import { useEffect } from 'react';
import { copy } from '../copy';

/**
 * Names the browser tab after the page: "<Page> - <Trip> - Trippy".
 *
 * Most specific first, because a tab strip truncates from the right and the
 * brand is the one part every tab shares. A plain hyphen between the parts,
 * which is what the house style uses in place of a dash. Empty parts are
 * dropped, so a page that has not loaded its trip yet reads "Trippy" rather
 * than " - Trippy".
 *
 * Not restored on unmount: every route sets its own, and restoring would make
 * the tab flicker back to the previous page's title for one frame between the
 * two.
 */
export default function useDocumentTitle(parts: readonly (string | null | undefined)[]): void {
	const title = [
		...parts.filter((p): p is string => !!p && p.trim() !== ''),
		copy.shell.brand
	].join(' - ');
	useEffect(() => {
		document.title = title;
	}, [title]);
}
