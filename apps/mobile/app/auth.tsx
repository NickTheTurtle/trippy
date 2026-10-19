import { useEffect } from 'react';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Loading } from '../src/ui';

// On web, Google or Apple hands back to this page inside the sign-in popup.
// This passes the address to the window that opened it, which reads the code
// from it, closes the popup and finishes signing in there. Anywhere else, or
// on any other page, it does nothing.
WebBrowser.maybeCompleteAuthSession();

/**
 * Where a Google or Apple sign-in returns to (`Linking.createURL('auth')`).
 *
 * The auth session that opened the provider reads the code from this link
 * itself (on iOS the system intercepts it before the app sees it), so there is
 * nothing to do here. But Android and web can also route the link into the
 * app, and it must not land on a blank or missing screen: it steps back to the
 * screen that started the sign-in, or, opened cold, to the start.
 */
export default function AuthReturn() {
	useEffect(() => {
		if (router.canGoBack()) router.back();
		else router.replace('/');
	}, []);
	return <Loading />;
}
