import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/ui/Toast';
import { copy } from '@trippy/copy';
import { color, type } from '../src/theme';

export default function RootLayout() {
	return (
		<SafeAreaProvider>
			<GestureHandlerRootView style={{ flex: 1 }}>
				<AuthProvider>
					<ToastProvider>
						<StatusBar style="dark" />
						<Stack
							screenOptions={{
								headerStyle: { backgroundColor: color.bg },
								headerShadowVisible: false,
								headerTintColor: color.accent,
								headerTitleStyle: type.head,
								headerLargeTitle: true,
								headerLargeTitleStyle: type.largeTitle,
								contentStyle: { backgroundColor: color.bg }
							}}
						>
							<Stack.Screen name="index" options={{ headerShown: false }} />
							<Stack.Screen name="login" options={{ headerShown: false }} />
							<Stack.Screen name="register" options={{ headerShown: false }} />
							<Stack.Screen name="forgot" options={{ headerShown: false }} />
							<Stack.Screen name="verify" options={{ headerShown: false }} />
							<Stack.Screen name="reset" options={{ headerShown: false }} />
							<Stack.Screen name="verify-email" options={{ headerShown: false }} />
							<Stack.Screen name="trips" options={{ title: copy.trips.heading }} />
							<Stack.Screen name="account" options={{ title: copy.account.heading }} />
							<Stack.Screen name="trip/[tripId]" options={{ headerShown: false }} />
						</Stack>
					</ToastProvider>
				</AuthProvider>
			</GestureHandlerRootView>
		</SafeAreaProvider>
	);
}
