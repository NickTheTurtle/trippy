import { useEffect, useState } from 'react';

/**
 * Whether a CSS media query currently matches.
 *
 * For the handful of places where a breakpoint changes *what is rendered*
 * rather than how it looks. Anything CSS can answer on its own belongs in CSS;
 * this exists for the cases where the markup itself has to differ, such as an
 * overflow count that has to stay honest about how many faces were left out.
 */
export default function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

	useEffect(() => {
		const mql = window.matchMedia?.(query);
		if (!mql) return;
		// Read once on subscribe as well: the query can have changed between the
		// first render and this effect, and between two different `query` values.
		setMatches(mql.matches);
		const on = (e: MediaQueryListEvent) => setMatches(e.matches);
		mql.addEventListener('change', on);
		return () => mql.removeEventListener('change', on);
	}, [query]);

	return matches;
}

/**
 * Below this the pages that carry a 190px column render their own narrow form.
 *
 * Tailwind's `lg`, because that is the breakpoint at which those pages already
 * drop their `lg:grid-cols-[190px_minmax(0,1fr)]` column. Keep the two in step
 * by hand: a mismatch leaves a band where the grid has collapsed but the nav
 * still styles itself as a sidebar, which is exactly what the 860px value this
 * replaced used to do.
 */
export const NARROW_QUERY = '(max-width: 1023.98px)';

/** True while the viewport is too narrow for the column layout. */
export function useNarrowLayout(): boolean {
	return useMediaQuery(NARROW_QUERY);
}
