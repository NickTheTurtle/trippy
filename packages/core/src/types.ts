// Shared domain enums & types for the Trip Planner.
// Kept framework-agnostic so both client and server import from here.

export type Role = 'organizer' | 'member';

export type ItemType =
	| 'poi'
	| 'meal'
	| 'travel'
	| 'lodging'
	| 'freetime'
	| 'meetup';

export type BookingStatus = 'booked' | 'tentative' | 'unbooked';

export type TravelMode = 'walk' | 'drive' | 'transit' | 'rail' | 'flight';

export type SplitRule = 'equal' | 'shares' | 'exact' | 'percent';

export interface Money {
	amount: number;
	currency: string; // ISO 4217, e.g. "USD"
}

export interface GeoPoint {
	lat: number;
	lng: number;
}
