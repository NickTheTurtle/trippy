import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useFocusEffect } from 'expo-router';

type AddAction = (() => void) | null;

// Two contexts: tabs only set the action, and the setter never changes, so a
// new action (every tab switch, every schedule reload) redraws the button that
// reads it and not every tab that sets one.
const SetAddActionContext = createContext<Dispatch<SetStateAction<AddAction>> | null>(null);
const AddActionContext = createContext<AddAction>(null);

/**
 * What the trip's Add button does, set by whichever tab is showing: a place on
 * Discover, a task or a cost on Preparation, an event on Schedule. The button is
 * the floating one drawn by `tripTab`; a tab with nothing to add (a locked
 * schedule) sets null and the button goes away.
 */
export function TripAddActionProvider({ children }: { children: ReactNode }) {
	const [action, setAction] = useState<AddAction>(null);
	return (
		<SetAddActionContext.Provider value={setAction}>
			<AddActionContext.Provider value={action}>{children}</AddActionContext.Provider>
		</SetAddActionContext.Provider>
	);
}

export function useTripAddAction(action: AddAction) {
	const setAction = useContext(SetAddActionContext);
	useFocusEffect(
		useCallback(() => {
			setAction?.(() => action);
			return () => setAction?.((cur) => (cur === action ? null : cur));
		}, [setAction, action])
	);
}

export function useCurrentTripAddAction(): AddAction {
	return useContext(AddActionContext);
}
