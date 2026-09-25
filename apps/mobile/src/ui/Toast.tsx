import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space, type } from '../theme';

type ToastKind = 'success' | 'error';
type ToastState = { kind: ToastKind; message: string } | null;
type ToastApi = {
	success: (message: string) => void;
	error: (message: string) => void;
	clear: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toast, setToast] = useState<ToastState>(null);
	const insets = useSafeAreaInsets();
	const show = useCallback((kind: ToastKind, message: string) => {
		setToast({ kind, message });
		setTimeout(() => setToast((current) => (current?.message === message ? null : current)), 3500);
	}, []);
	const value = useMemo(
		() => ({
			success: (message: string) => show('success', message),
			error: (message: string) => show('error', message),
			clear: () => setToast(null)
		}),
		[show]
	);

	return (
		<ToastContext.Provider value={value}>
			{children}
			{toast ? (
				<Pressable
					accessibilityRole="button"
					onPress={() => setToast(null)}
					style={{
						position: 'absolute',
						left: space.lg,
						right: space.lg,
						top: insets.top + space.sm,
						zIndex: 20
					}}
				>
					<View
						style={{
							borderRadius: radius.section,
							paddingHorizontal: space.md,
							paddingVertical: space.sm,
							backgroundColor: toast.kind === 'error' ? color.dangerSoft : color.accentSoft,
							shadowColor: '#000',
							shadowOpacity: 0.1,
							shadowRadius: 12,
							shadowOffset: { width: 0, height: 6 }
						}}
					>
						<Text
							style={{
								...type.footnote,
								color: toast.kind === 'error' ? color.dangerInk : color.accentInk,
								fontWeight: '600'
							}}
						>
							{toast.message}
						</Text>
					</View>
				</Pressable>
			) : null}
		</ToastContext.Provider>
	);
}

export function useToast(): ToastApi {
	const ctx = useContext(ToastContext);
	if (!ctx) throw new Error('useToast outside ToastProvider');
	return ctx;
}
