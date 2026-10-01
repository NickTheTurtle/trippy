import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

/**
 * Whether this client can draw SwiftUI views through @expo/ui (the system menu,
 * the calendar popover). Expo Go SDK 57 ships the module; the check keeps a
 * client without it on the React Native fallbacks instead of crashing, since
 * @expo/ui looks up its native views as soon as it is imported. So it is only
 * ever required (in the `.ios` files) after this says yes.
 */
export const hasSwiftUI = Platform.OS === 'ios' && requireOptionalNativeModule('ExpoUI') != null;

/**
 * SwiftUI names a custom face by its PostScript name, not by the alias React
 * Native loads it under (`Fraunces_600SemiBold`). expo-font registers the file
 * for the whole process, so SwiftUI finds it by this name; if it ever did not,
 * SwiftUI would fall back to the system font at the same size.
 */
export const serifPostScript = 'Fraunces-SemiBold';
