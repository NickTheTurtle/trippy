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
	BRL: 5.45,
	// The common travel currencies beyond the original twenty. An international
	// trip planner that cannot record a dinner in dong or lira pushes people to
	// convert by hand, which is the one job the ledger exists to do for them.
	AED: 3.67,
	ARS: 900,
	BGN: 1.8,
	CLP: 930,
	COP: 3950,
	CRC: 525,
	CZK: 23.2,
	DKK: 6.87,
	EGP: 47.8,
	HUF: 360,
	IDR: 16000,
	ILS: 3.7,
	ISK: 138,
	KES: 129,
	MAD: 9.9,
	MYR: 4.7,
	PEN: 3.75,
	PHP: 58,
	PKR: 278,
	PLN: 3.95,
	QAR: 3.64,
	RON: 4.58,
	SAR: 3.75,
	TRY: 32.5,
	VND: 25400
};

/** Every supported code, USD first and the rest alphabetical. */
export const CURRENCY_CODES: string[] = [
	'USD',
	...Object.keys(FALLBACK_RATES)
		.filter((c) => c !== 'USD')
		.sort()
];

/**
 * Whether a code is one the app can convert without the network.
 *
 * Every write that stores a currency asks this. Before it did, any three
 * letters were accepted and the first read that tried to convert them threw
 * out of `perUsd`, which answered the whole expenses page with a 500 for every
 * member of the trip. Case-sensitive on purpose: callers upper-case first, so
 * what is checked is exactly what is stored.
 */
export function isCurrencyCode(code: string): boolean {
	return Object.prototype.hasOwnProperty.call(FALLBACK_RATES, code);
}

/** What an unsupported currency is told. Shared so every field says the same thing. */
export function unknownCurrency(): string {
	return 'Pick a currency from the list.';
}
