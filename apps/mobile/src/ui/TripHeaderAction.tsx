import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode
} from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useFocusEffect } from 'expo-router';

type HeaderAction = (() => void) | null;
type HeaderActionContextValue = {
	action: HeaderAction;
	setAction: Dispatch<SetStateAction<HeaderAction>>;
};

const HeaderActionContext = createContext<HeaderActionContextValue | null>(null);

export function TripHeaderActionProvider({ children }: { children: ReactNode }) {
	const [action, setAction] = useState<HeaderAction>(null);
	const value = useMemo(() => ({ action, setAction }), [action]);
	return <HeaderActionContext.Provider value={value}>{children}</HeaderActionContext.Provider>;
}

export function useTripHeaderAction(action: HeaderAction) {
	const ctx = useContext(HeaderActionContext);
	useFocusEffect(
		useCallback(() => {
			ctx?.setAction(() => action);
			return () => ctx?.setAction((cur) => (cur === action ? null : cur));
		}, [ctx, action])
	);
}

export function useCurrentTripHeaderAction(): HeaderAction {
	return useContext(HeaderActionContext)?.action ?? null;
}
