import { Platform } from 'react-native';
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
							<Stack.Screen
								name="register"
								options={{ title: '', headerTransparent: true, headerLargeTitle: false }}
							/>
							<Stack.Screen
								name="forgot"
								options={{ title: '', headerTransparent: true, headerLargeTitle: false }}
							/>
							<Stack.Screen name="verify" options={{ headerShown: false }} />
							<Stack.Screen name="reset" options={{ headerShown: false }} />
							<Stack.Screen name="verify-email" options={{ headerShown: false }} />
							<Stack.Screen name="trips" options={{ title: copy.trips.heading }} />
							<Stack.Screen name="account" options={{ title: copy.account.heading }} />
							<Stack.Screen
								name="trip/[tripId]"
								options={
									// iOS: the stack's own bar, so a trip gets the system header
									// and back button from the first frame; the trip layout adds
									// the title and buttons. Elsewhere the trip's tabs draw it.
									Platform.OS === 'ios'
										? {
												headerShown: true,
												headerLargeTitle: false,
												headerBackButtonDisplayMode: 'minimal',
												title: ''
											}
										: { headerShown: false }
								}
							/>
						</Stack>
					</ToastProvider>
				</AuthProvider>
			</GestureHandlerRootView>
		</SafeAreaProvider>
	);
}
