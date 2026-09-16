import { CURRENCY_CODES } from '@trippy/core/currency';

export { CURRENCY_CODES };

/**
 * The currency choices, in one place.
 *
 * The list itself lives in `@trippy/core/currency`, beside the offline rate
 * table, because a currency the app offers but cannot convert is worse than
 * one it does not offer at all: see the note there. It is the fallback for the
 * fields that have no server list of their own, and the whole list for the
 * home currency, which is what every other amount converts into.
 *
 * `currencyOptions` used to build `Select` options from it. Every currency
 * field is now `CurrencyPicker`, which takes the codes themselves, so the
 * option shape it existed to keep identical is no longer built anywhere.
 */

/**
 * English names for the codes, for searching and for reading.
 *
 * Here rather than beside `FALLBACK_RATES` in core on purpose. That table is
 * the definition of a currency the app can convert offline, and its comment
 * says so; this map is a display label, and it has to cover the roughly 160
 * codes the live FX feed adds on top of those twenty, which core has never
 * heard of and must not be read as supporting.
 *
 * A code with no entry renders as the code alone. Half the point of the name
 * is to be searched for, so a guessed one is worse than none.
 */
export const CURRENCY_NAMES: Record<string, string> = {
	AED: 'United Arab Emirates Dirham',
	AFN: 'Afghan Afghani',
	ALL: 'Albanian Lek',
	AMD: 'Armenian Dram',
	ANG: 'Netherlands Antillean Guilder',
	AOA: 'Angolan Kwanza',
	ARS: 'Argentine Peso',
	AUD: 'Australian Dollar',
	AWG: 'Aruban Florin',
	AZN: 'Azerbaijani Manat',
	BAM: 'Bosnia-Herzegovina Convertible Mark',
	BBD: 'Barbadian Dollar',
	BDT: 'Bangladeshi Taka',
	BGN: 'Bulgarian Lev',
	BHD: 'Bahraini Dinar',
	BIF: 'Burundian Franc',
	BMD: 'Bermudian Dollar',
	BND: 'Brunei Dollar',
	BOB: 'Bolivian Boliviano',
	BRL: 'Brazilian Real',
	BSD: 'Bahamian Dollar',
	BTN: 'Bhutanese Ngultrum',
	BWP: 'Botswanan Pula',
	BYN: 'Belarusian Ruble',
	BZD: 'Belize Dollar',
	CAD: 'Canadian Dollar',
	CDF: 'Congolese Franc',
	CHF: 'Swiss Franc',
	CLP: 'Chilean Peso',
	CNY: 'Chinese Yuan',
	COP: 'Colombian Peso',
	CRC: 'Costa Rican Colon',
	CUP: 'Cuban Peso',
	CVE: 'Cape Verdean Escudo',
	CZK: 'Czech Koruna',
	DJF: 'Djiboutian Franc',
	DKK: 'Danish Krone',
	DOP: 'Dominican Peso',
	DZD: 'Algerian Dinar',
	EGP: 'Egyptian Pound',
	ERN: 'Eritrean Nakfa',
	ETB: 'Ethiopian Birr',
	EUR: 'Euro',
	FJD: 'Fijian Dollar',
	FKP: 'Falkland Islands Pound',
	GBP: 'British Pound',
	GEL: 'Georgian Lari',
	GHS: 'Ghanaian Cedi',
	GIP: 'Gibraltar Pound',
	GMD: 'Gambian Dalasi',
	GNF: 'Guinean Franc',
	GTQ: 'Guatemalan Quetzal',
	GYD: 'Guyanaese Dollar',
	HKD: 'Hong Kong Dollar',
	HNL: 'Honduran Lempira',
	HRK: 'Croatian Kuna',
	HTG: 'Haitian Gourde',
	HUF: 'Hungarian Forint',
	IDR: 'Indonesian Rupiah',
	ILS: 'Israeli New Shekel',
	INR: 'Indian Rupee',
	IQD: 'Iraqi Dinar',
	IRR: 'Iranian Rial',
	ISK: 'Icelandic Krona',
	JMD: 'Jamaican Dollar',
	JOD: 'Jordanian Dinar',
	JPY: 'Japanese Yen',
	KES: 'Kenyan Shilling',
	KGS: 'Kyrgystani Som',
	KHR: 'Cambodian Riel',
	KMF: 'Comorian Franc',
	KPW: 'North Korean Won',
	KRW: 'South Korean Won',
	KWD: 'Kuwaiti Dinar',
	KYD: 'Cayman Islands Dollar',
	KZT: 'Kazakhstani Tenge',
	LAK: 'Laotian Kip',
	LBP: 'Lebanese Pound',
	LKR: 'Sri Lankan Rupee',
	LRD: 'Liberian Dollar',
	LSL: 'Lesotho Loti',
	LYD: 'Libyan Dinar',
	MAD: 'Moroccan Dirham',
	MDL: 'Moldovan Leu',
	MGA: 'Malagasy Ariary',
	MKD: 'Macedonian Denar',
	MMK: 'Myanmar Kyat',
	MNT: 'Mongolian Tugrik',
	MOP: 'Macanese Pataca',
	MRU: 'Mauritanian Ouguiya',
	MUR: 'Mauritian Rupee',
	MVR: 'Maldivian Rufiyaa',
	MWK: 'Malawian Kwacha',
	MXN: 'Mexican Peso',
	MYR: 'Malaysian Ringgit',
	MZN: 'Mozambican Metical',
	NAD: 'Namibian Dollar',
	NGN: 'Nigerian Naira',
	NIO: 'Nicaraguan Cordoba',
	NOK: 'Norwegian Krone',
	NPR: 'Nepalese Rupee',
	NZD: 'New Zealand Dollar',
	OMR: 'Omani Rial',
	PAB: 'Panamanian Balboa',
	PEN: 'Peruvian Sol',
	PGK: 'Papua New Guinean Kina',
	PHP: 'Philippine Peso',
	PKR: 'Pakistani Rupee',
	PLN: 'Polish Zloty',
	PYG: 'Paraguayan Guarani',
	QAR: 'Qatari Rial',
	RON: 'Romanian Leu',
	RSD: 'Serbian Dinar',
	RUB: 'Russian Ruble',
	RWF: 'Rwandan Franc',
	SAR: 'Saudi Riyal',
	SBD: 'Solomon Islands Dollar',
	SCR: 'Seychellois Rupee',
	SDG: 'Sudanese Pound',
	SEK: 'Swedish Krona',
	SGD: 'Singapore Dollar',
	SHP: 'Saint Helena Pound',
	SLE: 'Sierra Leonean Leone',
	SOS: 'Somali Shilling',
	SRD: 'Surinamese Dollar',
	SSP: 'South Sudanese Pound',
	STN: 'Sao Tome and Principe Dobra',
	SYP: 'Syrian Pound',
	SZL: 'Swazi Lilangeni',
	THB: 'Thai Baht',
	TJS: 'Tajikistani Somoni',
	TMT: 'Turkmenistani Manat',
	TND: 'Tunisian Dinar',
	TOP: "Tongan Pa'anga",
	TRY: 'Turkish Lira',
	TTD: 'Trinidad and Tobago Dollar',
	TWD: 'New Taiwan Dollar',
	TZS: 'Tanzanian Shilling',
	UAH: 'Ukrainian Hryvnia',
	UGX: 'Ugandan Shilling',
	USD: 'US Dollar',
	UYU: 'Uruguayan Peso',
	UZS: 'Uzbekistani Som',
	VES: 'Venezuelan Bolivar',
	VND: 'Vietnamese Dong',
	VUV: 'Vanuatu Vatu',
	WST: 'Samoan Tala',
	XAF: 'Central African CFA Franc',
	XCD: 'East Caribbean Dollar',
	XOF: 'West African CFA Franc',
	XPF: 'CFP Franc',
	YER: 'Yemeni Rial',
	ZAR: 'South African Rand',
	ZMW: 'Zambian Kwacha',
	ZWL: 'Zimbabwean Dollar'
};

/** The name we have for a code, or '' when there is none to show. */
export function currencyName(code: string): string {
	return CURRENCY_NAMES[code] ?? '';
}

/**
 * The codes matching a typed query, best first. An empty query is everything,
 * in the order given.
 *
 * Both halves of a row are searched, because the two ways people reach for a
 * currency are its code and its name: "jpy" and "yen" have to find the same
 * row. The code wins over the name at equal footing, so "us" opens on USD
 * rather than on whichever name happens to contain it, and a prefix beats a
 * match buried mid-word, which is what makes Enter on the top row right.
 */
export function searchCurrencies(codes: readonly string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...codes];
	const ranked: { code: string; rank: number }[] = [];
	for (const code of codes) {
		const lower = code.toLowerCase();
		const name = currencyName(code).toLowerCase();
		const rank = lower.startsWith(q)
			? 0
			: name.split(/[\s-]+/).some((w) => w.startsWith(q))
				? 1
				: lower.includes(q)
					? 2
					: name.includes(q)
						? 3
						: -1;
		if (rank >= 0) ranked.push({ code, rank });
	}
	// A stable sort, so codes keep the server's order within a rank.
	return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.code);
}
