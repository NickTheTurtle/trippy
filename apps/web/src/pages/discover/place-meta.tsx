import { localDayMinutes } from '@trippy/core/tz';
import type { PlaceHit } from '../../lib/api-types';

/** Shortest query worth a billed request. Mirrors MIN_QUERY on the server. */
export const MIN_QUERY = 3;

/**
 * Identity for a result across a re-fetch: providers do not give stable ids.
 *
 * The address is part of it because the coordinates are not always there. A
 * suggestion arrives with null lat and lng, so two of them collapsed to the
 * same key and React drew them as one row with a duplicate-key warning. Name
 * and address together are what tells two suggestions apart on screen, so they
 * are what tells them apart here.
 */
export const hitKey = (h: PlaceHit) => `${h.name}|${h.address ?? ''}|${h.lat}|${h.lng}`;

/** Google's price level as the band people recognise. */
export const priceStr = (level: number | null | undefined) =>
	level == null ? '' : '$'.repeat(Math.max(1, level));

/** The stored `hours` column is a JSON array of weekday lines. */
export function parseHours(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const v: unknown = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : null;
	} catch {
		return null;
	}
}

/**
 * Today's opening hours, for the city the place is in.
 *
 * This used to read `new Date().getDay()`, which is the *browser's* weekday: a
 * member in California looking at an Athens trip late on a Sunday evening was
 * shown Sunday's hours while it was already Monday in Athens. The day is taken
 * from the city's IANA zone instead (`cities.tz`, which the trip payload already
 * carries), through the shared `localDayMinutes` helper.
 *
 * Returns null when the zone is unusable, because a plausible-looking wrong row
 * is worse than no row: hours are the one thing here somebody plans around.
 */
export function todayHours(hours: string[] | null | undefined, tz: string): string | null {
	if (!hours || hours.length === 0) return null;
	const { day } = localDayMinutes(tz);
	if (!day) return null;
	// The day string is a calendar date in `tz`; reading it back as UTC gives
	// that date's weekday without the browser's zone entering into it.
	const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
	if (Number.isNaN(weekday)) return null;
	// Google lists Monday-first; getUTCDay() is Sunday=0.
	const idx = (weekday + 6) % 7;
	// Drop the leading weekday name for a compact chip.
	return (hours[idx] ?? hours[0]).replace(/^[A-Za-z]+:\s*/, '');
}

/** Star rating, price band and today's hours: the row that describes a venue. */
export function MetaBits({
	rating,
	ratingCount,
	priceLevel,
	hours
}: {
	rating: number | null;
	ratingCount: number | null;
	priceLevel: number | null;
	hours: string | null;
}) {
	if (!rating && priceLevel == null && !hours) return null;
	return (
		<>
			{rating ? (
				<span className="font-semibold whitespace-nowrap text-warn">
					★ {rating.toFixed(1)}
					{ratingCount ? <span className="muted">&nbsp;({ratingCount})</span> : null}
				</span>
			) : null}
			{priceLevel != null && (
				<span className="font-semibold whitespace-nowrap text-accent-ink">
					{priceStr(priceLevel)}
				</span>
			)}
			{hours && <span className="whitespace-nowrap">{hours}</span>}
		</>
	);
}

/** The rating, price band and today's hours for a search result. */
export function HitSummary({ hit, tz, loading }: { hit: PlaceHit; tz: string; loading: boolean }) {
	const hrs = todayHours(hit.hours, tz);
	if (loading) {
		// Holds the summary line's height so the fields below do not jump down
		// when the ratings arrive.
		return <p aria-hidden="true" className="h-[1.2em] w-36 rounded-sm bg-line opacity-50" />;
	}
	if (!hit.rating && hit.priceLevel == null && !hrs) return null;
	return (
		<p className="muted m-0 flex flex-wrap items-center gap-1.5 text-meta">
			<MetaBits
				rating={hit.rating}
				ratingCount={hit.ratingCount}
				priceLevel={hit.priceLevel}
				hours={hrs}
			/>
		</p>
	);
}
