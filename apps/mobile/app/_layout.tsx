import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/ui/Toast';
import { copy } from '@trippy/copy';
import { color, font } from '../src/theme';

/**
 * The root of the native app.
 *
 * Everything is inside one Stack so a screen pushed from a tab (an expense, a
 * place, a person) slides in over the tab bar the way iOS users expect, rather
 * than replacing the whole frame.
 */
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
								headerTintColor: color.ink,
								headerTitleStyle: { ...font.heading, fontSize: 17 },
								headerTitle: ({ children }) => (
									<Text
										numberOfLines={1}
										ellipsizeMode="tail"
										style={{ ...font.heading, color: color.ink, fontSize: 17, maxWidth: 220 }}
									>
										{children}
									</Text>
								),
								contentStyle: { backgroundColor: color.bg }
							}}
						>
							<Stack.Screen name="index" options={{ headerShown: false }} />
							<Stack.Screen name="login" options={{ title: '' }} />
							<Stack.Screen name="register" options={{ title: '' }} />
							<Stack.Screen name="forgot" options={{ title: '' }} />
							<Stack.Screen name="verify" options={{ title: '' }} />
							<Stack.Screen name="reset" options={{ title: '' }} />
							<Stack.Screen name="verify-email" options={{ title: '' }} />
							<Stack.Screen name="trips" options={{ headerShown: false }} />
							<Stack.Screen name="account" options={{ title: copy.account.heading }} />
							<Stack.Screen name="trip/[tripId]" options={{ headerShown: false }} />
						</Stack>
					</ToastProvider>
				</AuthProvider>
			</GestureHandlerRootView>
		</SafeAreaProvider>
	);
}
