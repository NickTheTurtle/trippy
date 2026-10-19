import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { copy } from '../copy';

const c = copy.auth.providers;

/** `GET /auth/providers`: which sign-in providers this server is configured for. */
type Providers = { google: boolean; apple: boolean; appleNative: boolean };
type Provider = 'apple' | 'google';

/**
 * Asked once per page load and shared, so going from log in to create account
 * does not ask again and the buttons do not blink out and back in on the way.
 * A failure is not kept: the next mount asks afresh.
 */
let pending: Promise<Providers> | null = null;
function loadProviders(): Promise<Providers> {
	pending ??= api<Providers>('/auth/providers').catch((err: unknown) => {
		pending = null;
		throw err;
	});
	return pending;
}

/**
 * A path on this site, or nothing. `next` comes from history state, which the
 * app writes itself, but it is handed to the server as a redirect target, so
 * anything that could leave the origin (`//host`, `/\host`, a full URL) is
 * dropped rather than passed along.
 */
function sameOriginPath(next: string | undefined): string | undefined {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
		return undefined;
	}
	return next;
}

function startUrl(provider: Provider, next: string | undefined): string {
	const params = new URLSearchParams({ client: 'web' });
	const path = sameOriginPath(next);
	if (path) params.set('next', path);
	// The browser's zone, for the same reason register sends it: a new account's
	// "today" is the reader's rather than UTC's.
	params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
	return `/api/auth/${provider}/start?${params}`;
}

/**
 * Continue with Apple / Continue with Google, above the email form on log in
 * and create account, then a rule reading "or" between them and the form.
 *
 * Only the providers the server is configured for are drawn, and with none the
 * component draws nothing, so a deployment without them looks exactly as it
 * did before they existed. The form does not wait for the answer: it is the
 * way in that always works, and holding it back for an optional extra would
 * slow every sign-in down to the slowest request.
 *
 * Each button is a full-page navigation, not a fetch. The provider's consent
 * screen is its own site, and the round trip ends with the server setting the
 * session cookie and redirecting back into the app, whose ordinary boot
 * (`AuthProvider` asking `/auth/me`) picks the session up.
 *
 * Apple comes first because its guidelines ask that its button be at least as
 * prominent as any other sign-in option. Both follow their brand rules: Apple's
 * black button with the white mark, Google's white button with the coloured
 * "G" and a light border. The marks are inline SVG so nothing is loaded from a
 * third-party host.
 */
export default function ProviderButtons({ next }: { next?: string }) {
	const [providers, setProviders] = useState<Providers | null>(null);

	useEffect(() => {
		let live = true;
		loadProviders()
			.then((p) => {
				if (live) setProviders(p);
			})
			// No providers is the honest reading of a failed check: the email form
			// is still there and works.
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	if (!providers || (!providers.apple && !providers.google)) return null;

	const go = (provider: Provider) => window.location.assign(startUrl(provider, next));

	return (
		<div className="mb-5 flex flex-col gap-2.5">
			{providers.apple && (
				<button type="button" className="btn apple w-full" onClick={() => go('apple')}>
					<AppleMark />
					{c.apple}
				</button>
			)}
			{providers.google && (
				<button type="button" className="btn w-full" onClick={() => go('google')}>
					<GoogleMark />
					{c.google}
				</button>
			)}
			<div className="mt-2.5 flex items-center gap-3 text-meta text-ink-faint" role="separator">
				<span className="h-px flex-1 bg-line" />
				{c.divider}
				<span className="h-px flex-1 bg-line" />
			</div>
		</div>
	);
}

/** Apple's mark, on `currentColor` so it is white on the black button. */
function AppleMark() {
	return (
		<svg viewBox="0 0 814 1000" aria-hidden="true" className="size-4 shrink-0">
			<path
				fill="currentColor"
				d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
			/>
		</svg>
	);
}

/** Google's "G", in its own four colours on the white button. */
function GoogleMark() {
	return (
		<svg viewBox="0 0 48 48" aria-hidden="true" className="size-4 shrink-0">
			<path
				fill="#EA4335"
				d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
			/>
			<path
				fill="#4285F4"
				d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
			/>
			<path
				fill="#FBBC05"
				d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
			/>
			<path
				fill="#34A853"
				d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
			/>
		</svg>
	);
}
