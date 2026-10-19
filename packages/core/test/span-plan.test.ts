import { describe, expect, it } from 'vitest';
import {
	planDay,
	reflowAutoTimes,
	rowOnDay,
	suggestStart,
	type AutoTimedRow,
	type PlannableRow,
	type PlannableStay
} from '../src/plan';
import { carriesInto, normalizeSpan, onOneClock, reclock, type SpanRow } from '../src/span';

/**
 * Events that run past their own day, as the planner reads them.
 *
 * `span.test.ts` pins where a span sits on each day. This file pins what the
 * rest of core does with that: the stored form a write settles a span into,
 * and the planner, reflow and suggested start reading each covering block as
 * its part of the day, so the server and the clients' replans agree.
 */

const zones: Record<string, string> = {
	athens: 'Europe/Athens',
	athens2: 'Europe/Athens',
	tokyo: 'Asia/Tokyo',
	la: 'America/Los_Angeles'
};
const zoneOf = (id: string | null | undefined) => (id ? zones[id] : null);

const ANA = 'ana';
const BEN = 'ben';
const ROSTER = [ANA, BEN];

/* Far enough apart to be real journeys. */
const HOTEL = { lat: 37.975, lng: 23.734 };
const TRAILHEAD = { lat: 38.1, lng: 23.9 };
const TAVERNA = { lat: 38.12, lng: 23.95 };
const TOKYO_HOTEL = { lat: 35.68, lng: 139.76 };
const SUSHI = { lat: 35.66, lng: 139.7 };

function span(over: Partial<SpanRow>): SpanRow {
	return {
		type: 'activity',
		day: '2026-10-10',
		end_day: null,
		start_min: 600,
		end_min: 660,
		city_id: 'athens',
		end_city_id: null,
		...over
	};
}

function block(over: Partial<PlannableRow> & { id: string }): PlannableRow {
	return {
		type: 'activity',
		day: '2026-10-10',
		end_day: null,
		start_min: 600,
		end_min: 660,
		lat: null,
		lng: null,
		people: [],
		city_id: 'athens',
		end_city_id: null,
		...over
	};
}

function night(over: Partial<PlannableStay> & { id: string; day: string }): PlannableStay {
	return {
		type: 'stay',
		end_day: null,
		start_min: 1260,
		end_min: 1440,
		lat: HOTEL.lat,
		lng: HOTEL.lng,
		people: [],
		...over
	};
}

describe('the stored form of a span', () => {
	it('stores an end day equal to the start day as none', () => {
		expect(normalizeSpan(span({ end_day: '2026-10-10' }), zoneOf).end_day).toBeNull();
	});

	it('stores the departure city named again as no arrival city', () => {
		const n = normalizeSpan(span({ type: 'travel', end_city_id: 'athens' }), zoneOf);
		expect(n.end_city_id).toBeNull();
	});

	it('drops an arrival city from anything but a journey', () => {
		expect(normalizeSpan(span({ end_city_id: 'tokyo' }), zoneOf).end_city_id).toBeNull();
		expect(
			normalizeSpan(span({ type: 'stay', end_city_id: 'tokyo', end_day: '2026-10-12' }), zoneOf)
		).toEqual({ end_day: '2026-10-12', end_city_id: null, end_min: 660 });
	});

	it('stores a block ending at 00:00 tomorrow as one ending at 24:00 today', () => {
		expect(
			normalizeSpan(span({ end_day: '2026-10-11', start_min: 1200, end_min: 0 }), zoneOf)
		).toEqual({ end_day: null, end_city_id: null, end_min: 1440 });
		// Two cities on one clock are still one clock.
		expect(
			normalizeSpan(
				span({
					type: 'travel',
					end_day: '2026-10-11',
					start_min: 1200,
					end_min: 0,
					end_city_id: 'athens2'
				}),
				zoneOf
			)
		).toEqual({ end_day: null, end_city_id: 'athens2', end_min: 1440 });
	});

	it('keeps midnight on another clock as it is', () => {
		const east = span({
			type: 'travel',
			end_day: '2026-10-11',
			start_min: 1200,
			end_min: 0,
			end_city_id: 'tokyo'
		});
		expect(normalizeSpan(east, zoneOf)).toEqual({
			end_day: '2026-10-11',
			end_city_id: 'tokyo',
			end_min: 0
		});
	});

	it('ends a span of any length that runs to midnight on the last day it fills', () => {
		// Friday 08:00 to Monday 00:00 is Friday to Sunday, ending at 24:00.
		expect(
			normalizeSpan(span({ end_day: '2026-10-12', start_min: 480, end_min: 0 }), zoneOf)
		).toEqual({ end_day: '2026-10-11', end_city_id: null, end_min: 1440 });
	});

	it('knows which spans the one-day rules apply to', () => {
		expect(onOneClock(span({}), zoneOf)).toBe(true);
		expect(onOneClock(span({ end_day: '2026-10-11' }), zoneOf)).toBe(false);
		expect(onOneClock(span({ type: 'travel', end_city_id: 'tokyo' }), zoneOf)).toBe(false);
		expect(carriesInto(span({ end_day: '2026-10-11' }), '2026-10-11')).toBe(true);
		expect(carriesInto(span({ end_day: '2026-10-11' }), '2026-10-10')).toBe(false);
	});
});

describe('a block read as its part of a day', () => {
	const hike = block({ id: 'hike', end_day: '2026-10-12', start_min: 480, end_min: 1020 });

	it('is its start to midnight, the whole day, then midnight to its end', () => {
		expect(rowOnDay(hike, '2026-10-10')).toMatchObject({ start_min: 480, end_min: 1440 });
		expect(rowOnDay(hike, '2026-10-11')).toMatchObject({ start_min: 0, end_min: 1440 });
		expect(rowOnDay(hike, '2026-10-12')).toMatchObject({ start_min: 0, end_min: 1020 });
	});

	it('leaves a row with no day, or a one-day row, exactly as it came', () => {
		const bare = { ...block({ id: 'bare' }), day: undefined };
		expect(rowOnDay(bare, '2026-10-11')).toBe(bare);
		const plain = block({ id: 'plain' });
		expect(rowOnDay(plain, '2026-10-10')).toBe(plain);
	});
});

describe('planning a day a block runs across', () => {
	const lastNight = night({ id: 'hotel', day: '2026-10-10', end_day: '2026-10-13' });

	it('starts the morning at the stay when nothing carries over', () => {
		const lunch = block({
			id: 'lunch',
			day: '2026-10-11',
			start_min: 720,
			end_min: 780,
			...TAVERNA
		});
		const legs = planDay({ day: '2026-10-11', events: [lunch], incoming: [lastNight] }, ROSTER);
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([['hotel', 'lunch']]);
	});

	it('does not start a middle day at last night for the people on a multi-day activity', () => {
		const hike = block({
			id: 'hike',
			end_day: '2026-10-12',
			start_min: 480,
			end_min: 1020,
			people: [ANA],
			...TRAILHEAD
		});
		const legs = planDay({ day: '2026-10-11', events: [hike], incoming: [lastNight] }, ROSTER);
		// Ana is on the mountain from midnight to midnight: nothing is planned for her.
		expect(legs).toEqual([]);
		const benLunch = block({
			id: 'ben-lunch',
			day: '2026-10-11',
			start_min: 720,
			end_min: 780,
			people: [BEN],
			...TAVERNA
		});
		// Ben was not on it, so his morning still leaves the hotel.
		const split = planDay(
			{ day: '2026-10-11', events: [hike, benLunch], incoming: [lastNight] },
			ROSTER
		);
		expect(split.map((l) => [l.fromEventId, l.toEventId, l.people])).toEqual([
			['hotel', 'ben-lunch', [BEN]]
		]);
	});

	it('goes on from the multi-day activity on its last day', () => {
		const hike = block({
			id: 'hike',
			end_day: '2026-10-12',
			start_min: 480,
			end_min: 1020,
			...TRAILHEAD
		});
		const dinner = block({
			id: 'dinner',
			day: '2026-10-12',
			start_min: 1140,
			end_min: 1260,
			...TAVERNA
		});
		const legs = planDay(
			{ day: '2026-10-12', events: [dinner, hike], incoming: [lastNight] },
			ROSTER
		);
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([['hike', 'dinner']]);
		expect(legs[0].afterMin).toBe(1020);
	});

	it('plans the first day up to the start of the block and nothing out of it', () => {
		const hike = block({
			id: 'hike',
			end_day: '2026-10-12',
			start_min: 480,
			end_min: 1020,
			...TRAILHEAD
		});
		const legs = planDay(
			{ day: '2026-10-10', events: [hike], incoming: [night({ id: 'prev', day: '2026-10-09' })] },
			ROSTER
		);
		expect(legs.map((l) => [l.fromEventId, l.toEventId, l.beforeMin])).toEqual([
			['prev', 'hike', 480]
		]);
	});

	it('starts the landing day of a continuing journey where it lands', () => {
		const flight = block({
			id: 'flight',
			type: 'travel',
			day: '2026-10-10',
			end_day: '2026-10-11',
			start_min: 22 * 60,
			end_min: 15 * 60,
			city_id: 'athens',
			end_city_id: 'tokyo',
			...TOKYO_HOTEL
		});
		const sushi = block({
			id: 'sushi',
			day: '2026-10-11',
			start_min: 19 * 60,
			end_min: 20 * 60,
			city_id: 'tokyo',
			...SUSHI
		});
		const athensNight = night({ id: 'athens-hotel', day: '2026-10-10', end_day: '2026-10-11' });
		const legs = planDay(
			{ day: '2026-10-11', events: [flight, sushi], incoming: [athensNight], zoneOf },
			ROSTER
		);
		// Nobody walks out of the Athens hotel in Tokyo: the day starts at the gate.
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([['flight', 'sushi']]);
		expect(legs[0].afterMin).toBe(15 * 60);
		expect(legs[0].people).toEqual(ROSTER);
	});

	it('plans a same-day flight west on the arrival clock, before lunch where it lands', () => {
		const LAX = { lat: 33.94, lng: -118.41 };
		const DINER = { lat: 34.05, lng: -118.25 };
		const flight = block({
			id: 'flight',
			type: 'travel',
			start_min: 17 * 60,
			end_min: 11 * 60,
			city_id: 'tokyo',
			end_city_id: 'la',
			...LAX
		});
		const lunch = block({
			id: 'lunch',
			start_min: 13 * 60,
			end_min: 14 * 60,
			city_id: 'la',
			...DINER
		});
		expect(rowOnDay(flight, '2026-10-10', zoneOf)).toMatchObject({ start_min: 60, end_min: 660 });
		const legs = planDay(
			{ day: '2026-10-10', events: [lunch, flight], incoming: [], zoneOf },
			ROSTER
		);
		// Drawn from its departure it sat after lunch and nothing was planned.
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([['flight', 'lunch']]);
		expect(legs[0].afterMin).toBe(660);
	});

	it('walks a day on two clocks in real time: museum, flight, then lunch where it lands', () => {
		const LAX = { lat: 33.94, lng: -118.41 };
		const DINER = { lat: 34.05, lng: -118.25 };
		const MUSEUM = { lat: 35.72, lng: 139.77 };
		const hotel = night({
			id: 'hotel',
			day: '2026-10-09',
			end_day: '2026-10-10',
			city_id: 'tokyo',
			...TOKYO_HOTEL
		});
		const museum = block({
			id: 'museum',
			start_min: 12 * 60,
			end_min: 14 * 60,
			city_id: 'tokyo',
			...MUSEUM
		});
		const flight = block({
			id: 'flight',
			type: 'travel',
			start_min: 17 * 60,
			end_min: 11 * 60,
			city_id: 'tokyo',
			end_city_id: 'la',
			...LAX
		});
		const lunch = block({
			id: 'lunch',
			start_min: 13 * 60,
			end_min: 14 * 60,
			city_id: 'la',
			...DINER
		});
		const legs = planDay(
			{ day: '2026-10-10', events: [lunch, museum, flight], incoming: [hotel], zoneOf },
			ROSTER
		);
		// On the arrival clock the flight (01:00 to 11:00) is drawn before the
		// museum (12:00), and walking those minutes planned the airport back to
		// the museum. In real time the museum is first, the flight follows it,
		// and lunch follows the landing.
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([
			['hotel', 'museum'],
			['flight', 'lunch']
		]);
	});

	it('walks a day on one clock exactly as it did, whatever cities its blocks name', () => {
		const rows = [
			block({ id: 'b', start_min: 600, end_min: 660, city_id: 'athens', ...TRAILHEAD }),
			block({ id: 'a', start_min: 600, end_min: 660, city_id: 'la', ...TAVERNA }),
			block({ id: 'c', start_min: 540, end_min: 580, city_id: 'tokyo', ...HOTEL }),
			block({
				id: 'd',
				day: '2026-10-09',
				end_day: '2026-10-10',
				start_min: 1320,
				end_min: 480,
				city_id: 'athens',
				...TAVERNA
			})
		];
		const day = {
			day: '2026-10-10',
			events: rows,
			incoming: [night({ id: 'n', day: '2026-10-09' })]
		};
		expect(planDay({ ...day, zoneOf }, ROSTER)).toEqual(planDay(day, ROSTER));
		expect(planDay({ ...day, zoneOf }, ROSTER).length).toBeGreaterThan(0);
	});
});

describe('a clock re-read at the same instant', () => {
	it('re-reads a clock at the same instant on another one', () => {
		// 15:00 Tokyo on the 11th is 09:00 Athens the same day.
		expect(reclock('2026-10-11', 900, 'Asia/Tokyo', 'Europe/Athens')).toEqual({
			day: '2026-10-11',
			minutes: 540
		});
		// 02:00 Athens is 23:00 UTC the evening before.
		expect(reclock('2026-10-11', 120, 'Europe/Athens', null)).toEqual({
			day: '2026-10-10',
			minutes: 1380
		});
	});
});

describe('reflow and the suggested start around a span', () => {
	it('never moves a block that runs over several days, and follows its end today', () => {
		const train = {
			...block({
				id: 'train',
				day: '2026-10-09',
				end_day: '2026-10-10',
				start_min: 1320,
				end_min: 540,
				...HOTEL
			}),
			time_auto: true
		} satisfies AutoTimedRow;
		const museum = {
			...block({ id: 'museum', start_min: 900, end_min: 960, ...HOTEL }),
			time_auto: true
		} satisfies AutoTimedRow;
		const moved = reflowAutoTimes([train, museum], [], ROSTER, { day: '2026-10-10', zoneOf });
		// The train is never moved; the museum follows where the train stops today.
		expect(moved).toEqual([{ id: 'museum', startMin: 540, endMin: 600 }]);
	});

	it('reads rows as stored without a day, as every caller before spans did', () => {
		const a = { ...block({ id: 'a', start_min: 600, end_min: 700 }), time_auto: false };
		const b = { ...block({ id: 'b', start_min: 900, end_min: 960 }), time_auto: true };
		expect(reflowAutoTimes([a, b], [])).toEqual([{ id: 'b', startMin: 700, endMin: 760 }]);
	});

	it('suggests the end of the day so far, by each block on this day', () => {
		const overnight = block({ id: 'o', day: '2026-10-09', end_day: '2026-10-10', end_min: 480 });
		const lateStart = block({ id: 'l', day: '2026-10-10', end_day: '2026-10-11', start_min: 1200 });
		expect(suggestStart([overnight], '2026-10-10')).toBe(480);
		expect(suggestStart([lateStart], '2026-10-10')).toBe(1435);
		// Without a day the stored pair is read, as before.
		expect(suggestStart([overnight])).toBe(480);
	});
});
