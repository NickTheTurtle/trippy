import { createContext, useContext } from 'react';

/**
 * The id of the trip whose tabs are on screen.
 *
 * `useLocalSearchParams` reads the params of the *focused* route, and a tab
 * that has been navigated to but not yet focused reads them as undefined. That
 * produced requests to `/trips/undefined/...` on every tab but Discover, which
 * happened to be the initial route. The layout owns the `[tripId]` segment and
 * always sees it, so it reads the param once and hands it down.
 */
export const TripIdContext = createContext<string>('');

export function useTripId() {
	return useContext(TripIdContext);
}
