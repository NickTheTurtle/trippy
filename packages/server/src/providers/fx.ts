/**
 * Currency conversion to the trip's home currency.
 *
 * Rates are cached in memory and refreshed in the background from a keyless
 * endpoint (open.er-api.com). Conversion is synchronous and always available:
 * before the first refresh lands it uses the static fallback table below, so
 * balances never block on a network call.
 *
 * These rates are today's. A recorded transaction must not be revalued by
 * them: see `rateTo`, and the `fx_rate` column expenses store it in.
 */
import { FALLBACK_RATES } from '@trippy/core/currency';
import { env } from '../infra/env';

// Units of each currency per 1 USD. Static fallback; refreshed at runtime.
// The table lives in `@trippy/core/currency` so the home-currency picker and
// this cannot offer different sets: see the note there.
const FALLBACK: Record<string, number> = FALLBACK_RATES;

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

/**
 * Kick off a background refresh if the cache is stale. Safe to call often.
 *
 * Skipped entirely while `OFFLINE_PROVIDERS` is set. The FX feed
 * (open.er-api.com) is keyless and free, so unlike Places and Routes it is not
 * a cost problem and it does not get the throwing guard: a blocked call here
 * would be a false alarm. It is skipped for the other two reasons the offline
 * flag exists. Determinism, because live rates change under a test that asserts
 * a converted total, and independence, because a test must not fail when
 * somebody else's free service is down. `FALLBACK_RATES` in `@trippy/core` is
 * a complete table for every currency the app offers, so conversion keeps
 * working with no network at all; that is what a fresh clone with no keys
 * already relies on.
 */
export function ensureRatesFresh(): void {
	if (env.OFFLINE_PROVIDERS) return;
	if (Date.now() - fetchedAt > MAX_AGE_MS) void doRefresh();
}

/**
 * Rate: how many units of `currency` equal 1 USD.
 *
 * Throws on a code we cannot convert. The old default of 1 was the worst
 * possible answer: it is indistinguishable from a correct conversion, so a
 * currency we had no rate for was folded into the trip total at par and the
 * only sign of it was a balance that was quietly wrong. Every code the app
 * lets anyone pick is in the fallback table, so reaching this is a bug, and a
 * bug about money should be loud.
 */
function perUsd(currency: string): number {
	const rate = rates[currency] ?? FALLBACK[currency];
	if (rate === undefined) throw new Error(`No exchange rate for ${currency}`);
	return rate;
}

/**
 * Today's rate: units of `to` for one unit of `from`.
 *
 * Exported so a transaction can record the rate it was entered at. Every pair
 * goes through USD, which is the only column the upstream feed publishes.
 */
export function rateTo(from: string, to: string): number {
	if (from === to) return 1;
	return perUsd(to) / perUsd(from);
}

/** Apply a stored rate to an amount in minor units. */
export function atRate(cents: number, rate: number): number {
	return Math.round(cents * rate);
}

/** Convert an amount (in `from` minor units / cents) to `to` currency cents. */
export function convertCents(cents: number, from: string, to: string): number {
	if (from === to) return cents;
	return atRate(cents, rateTo(from, to));
}
