import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { Fraunces_600SemiBold, useFonts } from '@expo-google-fonts/fraunces';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/ui/Toast';
import { copy } from '@trippy/copy';
import { color, displayType, type } from '../src/theme';

export default function RootLayout() {
	// The web's heading face. Held back until it has loaded (or failed, when the
	// system font stands in) so the first titles do not reflow from one face to
	// the other; it ships inside the bundle, so this is a local read.
	const [fontsLoaded, fontError] = useFonts({ Fraunces_600SemiBold });
	if (!fontsLoaded && !fontError) return null;
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
								headerLargeTitleStyle: {
									fontFamily: displayType.largeTitle.fontFamily,
									fontSize: displayType.largeTitle.fontSize,
									color: displayType.largeTitle.color
								},
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
