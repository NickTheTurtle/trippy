import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';

type HeaderAction = (() => void) | null;
type HeaderActionContextValue = { action: HeaderAction; setAction: (action: HeaderAction) => void };

const HeaderActionContext = createContext<HeaderActionContextValue | null>(null);

export function TripHeaderActionProvider({ children }: { children: ReactNode }) {
	const [action, setAction] = useState<HeaderAction>(null);
	return (
		<HeaderActionContext.Provider value={{ action, setAction }}>
			{children}
		</HeaderActionContext.Provider>
	);
}

export function useTripHeaderAction(action: () => void) {
	const ctx = useContext(HeaderActionContext);
	useFocusEffect(
		useCallback(() => {
			ctx?.setAction(() => action);
			return () => ctx?.setAction(null);
		}, [ctx, action])
	);
}

export function useCurrentTripHeaderAction(): HeaderAction {
	return useContext(HeaderActionContext)?.action ?? null;
}
