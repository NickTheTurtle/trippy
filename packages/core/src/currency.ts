/**
 * The currencies the app supports, and the offline rate to convert them.
 *
 * There were two lists: the web's home-currency picker and the server's rate
 * table. They disagreed in both directions. The picker offered ZAR and BRL,
 * which the rate table had never heard of, so before the first live refresh
 * landed (or any time the feed was unreachable) `perUsd` fell back to 1 and
 * every foreign expense was folded into the trip total at par, silently, in a
 * number people settle real money against. It also omitted five currencies the
 * table did carry, for no reason beyond the two lists being typed separately.
 *
 * So the list lives here, where the rate table is the list. A currency exists
 * exactly when we can convert it without the network, which is the only
 * property either caller actually needs, and adding one is a single edit that
 * cannot be done by half.
 *
 * The rates are a static floor, deliberately stale. `providers/fx.ts` overlays
 * the live daily table on top; these are only what a conversion falls back to
 * so that balances never block on a fetch.
 */
export const FALLBACK_RATES: Record<string, number> = {
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
	TWD: 32.4,
	ZAR: 18.7,
	BRL: 5.45
};

/** Every supported code, USD first and the rest alphabetical. */
export const CURRENCY_CODES: string[] = [
	'USD',
	...Object.keys(FALLBACK_RATES)
		.filter((c) => c !== 'USD')
		.sort()
];

export function isCurrency(code: string): boolean {
	return code in FALLBACK_RATES;
}
