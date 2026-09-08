declare module 'tz-lookup' {
	/** Returns the IANA time zone name for the given latitude and longitude. */
	export default function tzlookup(lat: number, lng: number): string;
}
