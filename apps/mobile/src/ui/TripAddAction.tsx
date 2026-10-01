import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useFocusEffect } from 'expo-router';

type AddAction = (() => void) | null;
type AddActionContextValue = {
	action: AddAction;
	setAction: Dispatch<SetStateAction<AddAction>>;
};

const AddActionContext = createContext<AddActionContextValue | null>(null);

/**
 * What the trip's Add button does, set by whichever tab is showing: a place on
 * Discover, a task or a cost on Preparation, an event on Schedule. The button is
 * the floating one drawn by `tripTab`; a tab with nothing to add (a locked
 * schedule) sets null and the button goes away.
 */
export function TripAddActionProvider({ children }: { children: ReactNode }) {
	const [action, setAction] = useState<AddAction>(null);
	const value = useMemo(() => ({ action, setAction }), [action]);
	return <AddActionContext.Provider value={value}>{children}</AddActionContext.Provider>;
}

export function useTripAddAction(action: AddAction) {
	const ctx = useContext(AddActionContext);
	useFocusEffect(
		useCallback(() => {
			ctx?.setAction(() => action);
			return () => ctx?.setAction((cur) => (cur === action ? null : cur));
		}, [ctx, action])
	);
}

export function useCurrentTripAddAction(): AddAction {
	return useContext(AddActionContext)?.action ?? null;
}
