/**
 * Currency conversion to the trip's home currency.
 *
 * Rates are cached in memory and refreshed in the background from a keyless
 * endpoint (open.er-api.com). Conversion is synchronous and always available:
 * before the first refresh lands it uses the static fallback table below, so
 * balances never block on a network call.
 */

// Units of each currency per 1 USD. Static fallback; refreshed at runtime.
const FALLBACK: Record<string, number> = {
	USD: 1,
	EUR: 0.92,
	GBP: 0.79,
	CAD: 1.36,
	AUD: 1.52,
	JPY: 157,
	CNY: 7.24,
	HKD: 7.81,
	KRW: 1360,
	SGD: 1.35,
	THB: 36.5,
	INR: 83.4,
	MXN: 18.6,
	CHF: 0.9,
	SEK: 10.6,
	NOK: 10.7,
	NZD: 1.64,
	TWD: 32.4
};

let rates: Record<string, number> = { ...FALLBACK };
let fetchedAt = 0;
let refreshing = false;
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Currencies we can render as choices in the UI. */
export function knownCurrencies(): string[] {
	return Object.keys(rates);
}

async function doRefresh(): Promise<void> {
	if (refreshing) return;
	refreshing = true;
	try {
		const res = await fetch('https://open.er-api.com/v6/latest/USD');
		if (res.ok) {
			const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
			if (data.result === 'success' && data.rates) {
				rates = { ...FALLBACK, ...data.rates };
				fetchedAt = Date.now();
			}
		}
	} catch {
		// keep whatever rates we have
	} finally {
		refreshing = false;
	}
}

/** Kick off a background refresh if the cache is stale. Safe to call often. */
export function ensureRatesFresh(): void {
	if (Date.now() - fetchedAt > MAX_AGE_MS) void doRefresh();
}

/** Rate: how many units of `currency` equal 1 USD. Falls back to 1 if unknown. */
function perUsd(currency: string): number {
	return rates[currency] ?? FALLBACK[currency] ?? 1;
}

/** Convert an amount (in `from` minor units / cents) to `to` currency cents. */
export function convertCents(cents: number, from: string, to: string): number {
	if (from === to) return cents;
	const usd = cents / perUsd(from);
	return Math.round(usd * perUsd(to));
}

/** Whether the live rates have been fetched at least once this run. */
export function ratesLive(): boolean {
	return fetchedAt > 0;
}
