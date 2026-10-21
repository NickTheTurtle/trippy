import { useCallback, useEffect, useState } from 'react';

/**
 * A `RefreshControl` that spins for a pull, not for every load.
 *
 * Handing it `loading` meant every background load set `refreshing`, and on
 * iOS a refresh that was not pulled for is begun programmatically: React
 * Native moves the scroll view's content down by the spinner's height to show
 * it, then lifts it back when the load ends. On the Calendar that was every
 * day step and every live update, so the page dipped and rose under the
 * reader. A load nobody asked for keeps showing what is there (`useApi` holds
 * the old data), which is all the feedback it needs.
 *
 * `asked` covers the render between the pull and the load starting, since
 * `useApi` only reports loading once its effect has run.
 */
export function usePullRefresh(loading: boolean, refresh: () => void) {
	const [phase, setPhase] = useState<'idle' | 'asked' | 'loading'>('idle');
	useEffect(() => {
		if (phase === 'asked' && loading) setPhase('loading');
		else if (phase === 'loading' && !loading) setPhase('idle');
	}, [loading, phase]);
	const onRefresh = useCallback(() => {
		setPhase('asked');
		refresh();
	}, [refresh]);
	return { refreshing: phase !== 'idle', onRefresh };
}
