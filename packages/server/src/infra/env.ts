/**
 * Server configuration, read from `process.env`.
 *
 * The API server loads the repo's `.env` with `--env-file`, so these keys are
 * on `process.env` by the time a request is served. Reading it directly (rather
 * than through a framework's env module) keeps this package usable from any
 * Node entry point.
 *
 * Access is deliberately lazy via a getter rather than captured into a const at
 * module load, because the module graph is evaluated before the API server has
 * finished loading its .env file, and a captured value would be permanently
 * undefined.
 */
export const env = {
	/**
	 * "Never call a paid third party from this process."
	 *
	 * Set by every automated test harness (see `vitest.setup.ts` and the
	 * Playwright config). A test suite that reaches Google costs real money per
	 * run, is non-deterministic because the answers change under it, and ties CI
	 * to a third party's availability. A convention ("do not put a key in .env
	 * while testing") is not enough, because breaking it is silent and the only
	 * evidence arrives on a bill, so this is an explicit switch that the harness
	 * sets for itself and that no stray key can override.
	 */
	get OFFLINE_PROVIDERS(): boolean {
		return isTruthy(process.env.TRIPPY_OFFLINE_PROVIDERS);
	},
	/**
	 * The secret server-side Google key, or undefined when there is none.
	 *
	 * Deliberately undefined while `OFFLINE_PROVIDERS` is set, rather than
	 * checked separately at each call site. This is the single choke point every
	 * Google path already reads, so hiding the key here makes "no paid call" a
	 * property of the process rather than something each provider has to
	 * remember: `activeProvider()` reports `osm`, the Google branches are never
	 * entered, and nothing is left holding a key it could send.
	 */
	get GOOGLE_SERVER_KEY(): string | undefined {
		if (this.OFFLINE_PROVIDERS) return undefined;
		const serverKey = process.env.GOOGLE_SERVER_KEY;
		if (serverKey) return serverKey;
		// Compatibility for the rollout window only. Do not fall back to
		// GOOGLE_MAPS_KEY here: that key is served to browsers by design.
		const oldPlacesKey = process.env.GOOGLE_PLACES_KEY;
		if (oldPlacesKey) warnGooglePlacesFallback();
		return oldPlacesKey;
	},
	get GOOGLE_PLACES_KEY(): string | undefined {
		if (this.OFFLINE_PROVIDERS) return undefined;
		return process.env.GOOGLE_PLACES_KEY;
	},
	/**
	 * The browser key, handed to the client for the interactive map. Also hidden
	 * offline: Maps JavaScript loads are billed too, so a test run that renders a
	 * board must fall through to the keyless Leaflet map.
	 */
	get GOOGLE_MAPS_KEY(): string | undefined {
		if (this.OFFLINE_PROVIDERS) return undefined;
		return process.env.GOOGLE_MAPS_KEY;
	},
	get RESEND_API_KEY(): string | undefined {
		return process.env.RESEND_API_KEY;
	},
	/**
	 * Amazon SES, used in preference to Resend when both are configured. Read
	 * from the conventional AWS names rather than app-specific ones so a machine
	 * that already exports credentials for the CLI needs nothing added.
	 */
	get AWS_ACCESS_KEY_ID(): string | undefined {
		return process.env.AWS_ACCESS_KEY_ID;
	},
	get AWS_SECRET_ACCESS_KEY(): string | undefined {
		return process.env.AWS_SECRET_ACCESS_KEY;
	},
	/** Only set when the credentials are temporary ones from STS. */
	get AWS_SESSION_TOKEN(): string | undefined {
		return process.env.AWS_SESSION_TOKEN;
	},
	/** The region the SES identity is verified in. Not necessarily the app's. */
	get SES_REGION(): string {
		return process.env.SES_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
	},
	/** The From address invites are sent as. Its domain must be verified with the provider. */
	get MAIL_FROM(): string | undefined {
		return process.env.MAIL_FROM;
	},
	/** Where an invite's link points. The web app, not the API. */
	get APP_URL(): string {
		return process.env.APP_URL ?? 'http://localhost:5174';
	},
	/**
	 * The SNS topics the SES bounce receiver will act on, comma-separated.
	 *
	 * A valid SNS signature proves AWS wrote the message, not that it was written
	 * for us: any AWS account can create a topic, subscribe this URL to it and
	 * publish a perfectly signed "complaint" for any address. The topic ARN is
	 * part of the signed string, so an allowlist of our own topics is what ties a
	 * genuine message to our SES identity. Empty means none: every message is
	 * refused, which is the safe reading of a receiver nobody has configured.
	 */
	get SES_SNS_TOPIC_ARN(): string[] {
		return (process.env.SES_SNS_TOPIC_ARN ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	},
	/**
	 * The interface the API binds. Unset keeps Node's default of every interface,
	 * which a phone on the LAN needs to reach a dev server. Production sets
	 * `127.0.0.1`, because Caddy on the same host is the only intended client and
	 * a public socket would let callers skip it (and its TLS and headers).
	 */
	get HOST(): string | undefined {
		return process.env.HOST?.trim() || undefined;
	}
};

let warnedGooglePlacesFallback = false;

/** `1`, `true`, `yes` and `on` all mean set. Anything else, including empty, does not. */
function isTruthy(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase();
	return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Thrown when code reaches for a paid provider while `OFFLINE_PROVIDERS` is set.
 *
 * Hiding the key (above) is what makes the paid path unreachable; this is the
 * alarm for the case where a future change reaches one anyway. It is its own
 * class so the fallback handlers in `places.ts` can rethrow it instead of
 * degrading quietly: a test that accidentally shops for a billed provider must
 * fail loudly, not pass on OSM results nobody looked at.
 */
export class PaidProviderBlockedError extends Error {
	constructor(what: string) {
		super(
			`Refusing to call the paid provider "${what}": TRIPPY_OFFLINE_PROVIDERS is set. ` +
				'Automated tests use the keyless OpenStreetMap / Photon provider.'
		);
		this.name = 'PaidProviderBlockedError';
	}
}

/** Guard at the top of any function that would spend money. */
export function assertPaidProviderAllowed(what: string): void {
	if (env.OFFLINE_PROVIDERS) throw new PaidProviderBlockedError(what);
}

function warnGooglePlacesFallback(): void {
	if (warnedGooglePlacesFallback) return;
	warnedGooglePlacesFallback = true;
	console.warn(
		'GOOGLE_PLACES_KEY is deprecated. Set GOOGLE_SERVER_KEY for server-side Google Places and Routes calls.'
	);
}
