import { describe, expect, it } from 'vitest';
import { type PlannedLeg, type PlannerEvent } from '@trippy/core/travel';
import { isLocatedType } from '@trippy/core/types';
import {
	isDayOf,
	isNightOf,
	MIDNIGHT_MIN,
	planDay,
	reflowAutoTimes,
	resolveLeg,
	shiftDay,
	stayBand,
	stayEndOf,
	suggestStart,
	toPlannerEvent,
	type LegOverride,
	type PlannableStay
} from '@trippy/core/plan';

/* ------------------------------------------------------------------ fixtures */

/**
 * A stored row in the shape both ends actually hold: snake_case columns out of
 * SQLite on the server, the same names on the wire in the browser.
 */
type Row = PlannableStay & {
	title: string;
	poi_id: string | null;
	lodging_id: string | null;
};

/* Three cities, so a day can cross a zone change. Athens and Istanbul are an
   hour apart in local time and about 560 km apart on the ground; Chania is a
   ferry away from Athens. Coordinates are real enough for the distance bands
   in `guessLeg` to land where a reader would expect. */
const PLACE = {
	athensHotel: [37.9755, 23.7348],
	acropolis: [37.9715, 23.7257],
	athensPort: [37.9475, 23.6377],
	istanbulHotel: [41.0082, 28.9784],
	istanbulMosque: [41.0054, 28.9768],
	chaniaHotel: [35.5138, 24.018]
} as const;

function row(over: Partial<Row> & { id: string }): Row {
	return {
		day: '2026-04-16',
		end_day: null,
		title: over.title ?? over.id,
		type: 'activity',
		start_min: 600,
		end_min: 660,
		poi_id: null,
		lodging_id: null,
		lat: null,
		lng: null,
		people: [],
		...over
	};
}

function at(place: readonly [number, number], over: Partial<Row> & { id: string }): Row {
	return row({ lat: place[0], lng: place[1], ...over });
}

function stay(over: Partial<Row> & { id: string }): Row {
	return row({ type: 'stay', start_min: 900, end_min: 960, ...over });
}

const ANA = 'u-ana';
const BEN = 'u-ben';
const CAI = 'u-cai';
const GONE = 'u-gone';
const ROSTER = [ANA, BEN, CAI];

/* ------------------------------------------------- the old implementations */

/**
 * `toPlanner` from `packages/server/src/persistence/schedule.ts` and
 * `plannerEvent` from `apps/web/src/pages/schedule/replan.ts`, character for
 * character as they were before the extraction. They were already identical,
 * which is the point; they are kept here so the table below can prove the new
 * projection answers the same thing rather than asserting it does.
 */
function oldProjection(e: Row, roster: readonly string[]): PlannerEvent {
	const members = new Set(roster);
	return {
		id: e.id,
		type: e.type,
		startMin: e.start_min,
		endMin: e.end_min,
		lat: isLocatedType(e.type) ? e.lat : null,
		lng: isLocatedType(e.type) ? e.lng : null,
		people: e.people.length ? e.people.filter((id) => members.has(id)) : [...roster]
	};
}

/** `shiftDay`, as it stood in the server and in the web's `shared.ts`. */
function oldShiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function oldStayEnd(r: Row): string {
	return r.end_day ?? oldShiftDay(r.day, 1);
}

function oldIsNightOf(r: Row, day: string): boolean {
	return r.day <= day && day < oldStayEnd(r);
}

/** The filter inside the old `staysOnBoard`, over rows the old SQL selected. */
function oldServerBand(rows: Row[], day: string): Row[] {
	const key = (r: Row) =>
		`${r.lodging_id ?? r.poi_id ?? `${r.title}|${r.lat}|${r.lng}`}\u0000${[...r.people].sort().join(',')}`;
	const leavesOn = (r: Row) => oldStayEnd(r) === day;
	const covering = rows.filter((r) => r.day <= day && day <= oldStayEnd(r));
	const tonight = new Set(covering.filter((r) => !leavesOn(r)).map(key));
	return covering.filter((r) => !leavesOn(r) || !tonight.has(key(r)));
}

/** The old `boardStays` in the web's `replan.ts`, minus its sort. */
function oldWebBand(rows: Row[], day: string): Row[] {
	const key = (r: Row) =>
		`${r.lodging_id ?? r.poi_id ?? `${r.title}|${r.lat}|${r.lng}`}\u0000${[...r.people].sort().join(',')}`;
	const tonight = new Set(rows.filter((r) => oldIsNightOf(r, day)).map(key));
	return rows.filter((r) => oldIsNightOf(r, day) || !tonight.has(key(r)));
}

/* ------------------------------------------------------ the days under test */

interface Day {
	name: string;
	day: string;
	events: Row[];
	stays: Row[];
	incoming: Row[];
	roster: string[];
}

const DAYS: Day[] = [
	{
		name: 'empty day',
		day: '2026-04-16',
		events: [],
		stays: [],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'ordinary day: hotel, sight, hotel',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 600, end_min: 720, people: [ANA, BEN] })
		],
		stays: [
			stay({
				id: 'ath-stay',
				day: '2026-04-15',
				end_day: '2026-04-18',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: [ANA, BEN]
			})
		],
		incoming: [
			stay({
				id: 'ath-stay',
				day: '2026-04-15',
				end_day: '2026-04-18',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: [ANA, BEN]
			})
		],
		roster: ROSTER
	},
	{
		name: 'everyone: an empty people list is the whole roster',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 600, end_min: 720, people: [] }),
			at(PLACE.athensPort, { id: 'port', start_min: 900, end_min: 960, people: [] })
		],
		stays: [],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'a named list that has only left the trip empties to nobody',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 600, end_min: 720, people: [GONE] }),
			at(PLACE.athensPort, { id: 'port', start_min: 900, end_min: 960, people: [GONE] })
		],
		stays: [],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'a location-less block breaks the chain',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660, people: [] }),
			row({ id: 'blank', start_min: 700, end_min: 760, people: [] }),
			at(PLACE.athensPort, { id: 'port', start_min: 900, end_min: 960, people: [] })
		],
		stays: [],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'free time breaks the chain even though it has coordinates stored',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660, people: [] }),
			at(PLACE.athensHotel, {
				id: 'idle',
				type: 'freetime',
				start_min: 700,
				end_min: 760,
				people: []
			}),
			at(PLACE.athensPort, { id: 'port', start_min: 900, end_min: 960, people: [] })
		],
		stays: [],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'the group splits: two people to the museum, one to the port',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660, people: [ANA, BEN] }),
			at(PLACE.athensPort, { id: 'port', start_min: 780, end_min: 840, people: [ANA] }),
			at(PLACE.istanbulMosque, { id: 'mosque', start_min: 780, end_min: 840, people: [BEN] })
		],
		stays: [],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'a day that crosses a zone change: Athens morning, Istanbul night',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660, people: [] }),
			at(PLACE.athensPort, {
				id: 'flight',
				type: 'travel',
				start_min: 780,
				end_min: 900,
				lat: PLACE.istanbulMosque[0],
				lng: PLACE.istanbulMosque[1],
				people: []
			})
		],
		stays: [
			stay({
				id: 'ist-stay',
				day: '2026-04-16',
				end_day: '2026-04-19',
				lodging_id: 'l-ist',
				lat: PLACE.istanbulHotel[0],
				lng: PLACE.istanbulHotel[1],
				people: []
			})
		],
		incoming: [
			stay({
				id: 'ath-stay',
				day: '2026-04-13',
				end_day: '2026-04-16',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: []
			})
		],
		roster: ROSTER
	},
	{
		name: 'changing hotels: a checkout and a check-in on the same day',
		day: '2026-04-16',
		events: [],
		stays: [
			stay({
				id: 'ath-out',
				day: '2026-04-13',
				end_day: '2026-04-16',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: []
			}),
			stay({
				id: 'cha-in',
				day: '2026-04-16',
				end_day: '2026-04-19',
				lodging_id: 'l-cha',
				lat: PLACE.chaniaHotel[0],
				lng: PLACE.chaniaHotel[1],
				people: []
			})
		],
		incoming: [
			stay({
				id: 'ath-out',
				day: '2026-04-13',
				end_day: '2026-04-16',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: []
			})
		],
		roster: ROSTER
	},
	{
		name: 'the same room re-booked: the checkout chip is noise and is dropped',
		day: '2026-04-16',
		events: [],
		stays: [
			stay({
				id: 'ath-a',
				day: '2026-04-13',
				end_day: '2026-04-16',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: []
			}),
			stay({
				id: 'ath-b',
				day: '2026-04-16',
				end_day: '2026-04-19',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: []
			})
		],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'half the group sleeps elsewhere',
		day: '2026-04-16',
		events: [at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660, people: [] })],
		stays: [
			stay({
				id: 'ath-stay',
				day: '2026-04-16',
				end_day: '2026-04-18',
				lodging_id: 'l-ath',
				lat: PLACE.athensHotel[0],
				lng: PLACE.athensHotel[1],
				people: [ANA, BEN]
			}),
			stay({
				id: 'cha-stay',
				day: '2026-04-16',
				end_day: '2026-04-18',
				lodging_id: 'l-cha',
				lat: PLACE.chaniaHotel[0],
				lng: PLACE.chaniaHotel[1],
				people: [CAI]
			})
		],
		incoming: [],
		roster: ROSTER
	},
	{
		name: 'a trip with no members plans nothing rather than throwing',
		day: '2026-04-16',
		events: [
			at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660, people: [] }),
			at(PLACE.athensPort, { id: 'port', start_min: 780, end_min: 840, people: [] })
		],
		stays: [],
		incoming: [],
		roster: []
	}
];

/* ------------------------------------------------------------------- tests */

describe('the band and the projection still answer what both old paths did', () => {
	it.each(DAYS.map((d) => [d.name, d] as const))(
		'draws the band the old server and the old client both drew: %s',
		(_name, d) => {
			const covering = d.stays.filter((s) => isDayOf(s, d.day));
			expect(stayBand(covering, d.day)).toEqual(oldServerBand(d.stays, d.day));
			expect(stayBand(covering, d.day)).toEqual(oldWebBand(covering, d.day));
		}
	);

	it.each(DAYS.flatMap((d) => [...d.events, ...d.stays, ...d.incoming]).map((r) => [r.id, r]))(
		'projects a row exactly as the old projection did: %s',
		(_id, r) => {
			for (const roster of [ROSTER, [], [ANA]]) {
				expect(toPlannerEvent(r as Row, roster)).toEqual(oldProjection(r as Row, roster));
			}
		}
	);
});

describe('the table is not vacuous', () => {
	/**
	 * Every journey each day plans, spelled out as the pair of ends it joins.
	 *
	 * Counts alone would pass over a table of days that all plan nothing, and
	 * the pairs are the part that changed when stays stopped being destinations:
	 * a day whose only place to go was the hotel now plans nothing at all, and
	 * the morning out of last night's room is what is left.
	 *
	 * Sorted before comparing, because the order legs come back in is the order
	 * the chains were walked and is not a promise this table is making.
	 */
	const EXPECTED: Record<string, [string, string][]> = {
		'empty day': [],
		'ordinary day: hotel, sight, hotel': [['ath-stay', 'acro']],
		'everyone: an empty people list is the whole roster': [['acro', 'port']],
		'a named list that has only left the trip empties to nobody': [],
		'a location-less block breaks the chain': [],
		'free time breaks the chain even though it has coordinates stored': [],
		'the group splits: two people to the museum, one to the port': [
			['acro', 'mosque'],
			['acro', 'port']
		],
		'a day that crosses a zone change: Athens morning, Istanbul night': [['ath-stay', 'acro']],
		'changing hotels: a checkout and a check-in on the same day': [],
		'the same room re-booked: the checkout chip is noise and is dropped': [],
		'half the group sleeps elsewhere': [],
		'a trip with no members plans nothing rather than throwing': []
	};

	it('plans exactly the legs the table says, and no day is there by accident', () => {
		const sorted = (pairs: [string, string][]) =>
			[...pairs].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
		const planned = Object.fromEntries(
			DAYS.map((d) => [
				d.name,
				sorted(
					planDay({ day: d.day, events: d.events, incoming: d.incoming }, d.roster).map(
						(l) => [l.fromEventId, l.toEventId] as [string, string]
					)
				)
			])
		);
		expect(planned).toEqual(Object.fromEntries(DAYS.map((d) => [d.name, sorted(EXPECTED[d.name])])));
		expect(Object.values(planned).filter((legs) => legs.length > 0)).toHaveLength(4);
	});
});

describe('shiftDay', () => {
	it('moves a calendar day and is its own inverse', () => {
		expect(shiftDay('2026-04-16', 1)).toBe('2026-04-17');
		expect(shiftDay('2026-04-16', -1)).toBe('2026-04-15');
		expect(shiftDay('2026-04-16', 0)).toBe('2026-04-16');
		expect(shiftDay(shiftDay('2026-04-16', 7), -7)).toBe('2026-04-16');
	});

	it('crosses month, year and leap-day boundaries', () => {
		expect(shiftDay('2026-04-30', 1)).toBe('2026-05-01');
		expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
		expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31');
		expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
		expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01');
	});

	it('is unmoved by a DST transition in any of the trip zones', () => {
		// Europe/Athens springs forward on 2026-03-29 and falls back on
		// 2026-10-25; America/New_York on 2026-03-08 and 2026-11-01. A day
		// string is a calendar day, not an instant, so none of these is a short
		// day as far as this function is concerned.
		for (const d of ['2026-03-29', '2026-10-25', '2026-03-08', '2026-11-01']) {
			expect(shiftDay(shiftDay(d, -1), 1)).toBe(d);
			expect(shiftDay(d, 1) > d).toBe(true);
		}
		expect(shiftDay('2026-03-28', 1)).toBe('2026-03-29');
		expect(shiftDay('2026-03-29', 1)).toBe('2026-03-30');
		expect(shiftDay('2026-10-24', 1)).toBe('2026-10-25');
		expect(shiftDay('2026-10-25', 1)).toBe('2026-10-26');
	});
});

describe('nights and days of a stay', () => {
	const s = stay({ id: 's', day: '2026-04-16', end_day: '2026-04-19' });
	const single = stay({ id: 'one', day: '2026-04-16', end_day: null });

	it('reads the checkout day as exclusive for nights and inclusive for days', () => {
		expect(stayEndOf(s)).toBe('2026-04-19');
		expect(isNightOf(s, '2026-04-15')).toBe(false);
		expect(isNightOf(s, '2026-04-16')).toBe(true);
		expect(isNightOf(s, '2026-04-18')).toBe(true);
		expect(isNightOf(s, '2026-04-19')).toBe(false);
		expect(isDayOf(s, '2026-04-19')).toBe(true);
		expect(isDayOf(s, '2026-04-20')).toBe(false);
	});

	it('treats a null end_day as one night', () => {
		expect(stayEndOf(single)).toBe('2026-04-17');
		expect(isNightOf(single, '2026-04-16')).toBe(true);
		expect(isNightOf(single, '2026-04-17')).toBe(false);
		expect(isDayOf(single, '2026-04-17')).toBe(true);
	});
});

describe('the stay band', () => {
	const place = (id: string, over: Partial<Row>) =>
		stay({ id, lodging_id: null, poi_id: null, ...over });

	it('keeps a checkout when the room really changes', () => {
		const out = place('out', { day: '2026-04-13', end_day: '2026-04-16', title: 'Athens' });
		const inn = place('in', { day: '2026-04-16', end_day: '2026-04-19', title: 'Chania' });
		expect(stayBand([out, inn], '2026-04-16').map((r) => r.id)).toEqual(['out', 'in']);
	});

	it('drops a checkout when the same people are back in the same room that night', () => {
		const a = place('a', { day: '2026-04-13', end_day: '2026-04-16', title: 'Athens' });
		const b = place('b', { day: '2026-04-16', end_day: '2026-04-19', title: 'Athens' });
		expect(stayBand([a, b], '2026-04-16').map((r) => r.id)).toEqual(['b']);
	});

	it('keeps a checkout when the room is the same but the people are not', () => {
		const a = place('a', { day: '2026-04-13', end_day: '2026-04-16', people: [ANA, BEN] });
		const b = place('b', { day: '2026-04-16', end_day: '2026-04-19', people: [ANA] });
		expect(stayBand([a, b], '2026-04-16').map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('preserves input order rather than imposing one', () => {
		const a = place('a', { day: '2026-04-16', end_day: '2026-04-19', title: 'Athens' });
		const b = place('b', { day: '2026-04-16', end_day: '2026-04-19', title: 'Chania' });
		expect(stayBand([b, a], '2026-04-16').map((r) => r.id)).toEqual(['b', 'a']);
	});
});

describe('toPlannerEvent', () => {
	it('expands an empty people list to the whole roster', () => {
		expect(toPlannerEvent(row({ id: 'e', people: [] }), ROSTER).people).toEqual(ROSTER);
	});

	it('leaves a named list alone, in the order it was given', () => {
		expect(toPlannerEvent(row({ id: 'e', people: [BEN, ANA] }), ROSTER).people).toEqual([BEN, ANA]);
	});

	it('filters a named list to the roster', () => {
		expect(toPlannerEvent(row({ id: 'e', people: [ANA, GONE] }), ROSTER).people).toEqual([ANA]);
	});

	it('empties a list of people who have all left, to nobody rather than everybody', () => {
		expect(toPlannerEvent(row({ id: 'e', people: [GONE] }), ROSTER).people).toEqual([]);
	});

	it('expands to nobody when the trip has no members', () => {
		expect(toPlannerEvent(row({ id: 'e', people: [] }), []).people).toEqual([]);
	});

	it('blanks the coordinates of free time without the row losing them', () => {
		const idle = at(PLACE.acropolis, { id: 'idle', type: 'freetime' });
		expect(toPlannerEvent(idle, ROSTER).lat).toBeNull();
		expect(toPlannerEvent(idle, ROSTER).lng).toBeNull();
		expect(idle.lat).toBe(PLACE.acropolis[0]);
	});

	it('keeps the coordinates of a travel event, which is where it lands', () => {
		const flight = at(PLACE.istanbulMosque, { id: 'f', type: 'travel' });
		expect(toPlannerEvent(flight, ROSTER).lat).toBe(PLACE.istanbulMosque[0]);
	});

	it('renames the stored minute columns and nothing else', () => {
		const e = at(PLACE.acropolis, { id: 'e', start_min: 615, end_min: 700 });
		expect(toPlannerEvent(e, ROSTER)).toEqual({
			id: 'e',
			type: 'activity',
			startMin: 615,
			endMin: 700,
			lat: PLACE.acropolis[0],
			lng: PLACE.acropolis[1],
			people: ROSTER
		});
	});
});

describe('planDay', () => {
	const acro = at(PLACE.acropolis, { id: 'acro', start_min: 540, end_min: 660 });
	const port = at(PLACE.athensPort, { id: 'port', start_min: 780, end_min: 840 });
	const lastNight = stay({
		id: 'prev',
		day: '2026-04-15',
		end_day: '2026-04-16',
		lodging_id: 'l-prev',
		lat: PLACE.athensHotel[0],
		lng: PLACE.athensHotel[1]
	});

	it('plans no journey to a stay: a room is where a day starts, not somewhere to be', () => {
		const legs = planDay({ day: '2026-04-16', events: [acro, port], incoming: [lastNight] }, ROSTER);
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([
			['prev', 'acro'],
			['acro', 'port']
		]);
		expect(legs.map((l) => l.toEventId)).not.toContain('prev');
	});

	it('starts the morning at last night, as an origin with no time to be late for', () => {
		const legs = planDay(
			{ day: '2026-04-16', events: [acro], incoming: [lastNight] },
			ROSTER
		);
		expect(legs).toHaveLength(1);
		expect(legs[0].fromEventId).toBe('prev');
		expect(legs[0].afterMin).toBe(0);
		expect(legs[0].beforeMin).toBe(540);
	});

	it('gives each half of a split group its own morning', () => {
		const a = stay({
			id: 'a',
			day: '2026-04-15',
			end_day: '2026-04-16',
			lodging_id: 'l-a',
			lat: PLACE.athensHotel[0],
			lng: PLACE.athensHotel[1],
			people: [ANA]
		});
		const b = stay({
			id: 'b',
			day: '2026-04-15',
			end_day: '2026-04-16',
			lodging_id: 'l-b',
			lat: PLACE.chaniaHotel[0],
			lng: PLACE.chaniaHotel[1],
			people: [BEN]
		});
		const legs = planDay(
			{ day: '2026-04-16', events: [acro], incoming: [a, b] },
			[ANA, BEN]
		);
		expect(legs.map((l) => l.fromEventId).sort()).toEqual(['a', 'b']);
		expect(legs.map((l) => l.people)).toEqual([[ANA], [BEN]]);
	});

	it('breaks the chain across a block with no location', () => {
		const blank = row({ id: 'blank', start_min: 700, end_min: 740 });
		const legs = planDay(
			{ day: '2026-04-16', events: [acro, blank, port], incoming: [] },
			ROSTER
		);
		expect(legs).toHaveLength(0);
	});

	it('breaks the chain across free time even when coordinates are stored', () => {
		const idle = at(PLACE.athensHotel, {
			id: 'idle',
			type: 'freetime',
			start_min: 700,
			end_min: 740
		});
		const legs = planDay(
			{ day: '2026-04-16', events: [acro, idle, port], incoming: [] },
			ROSTER
		);
		expect(legs).toHaveLength(0);
	});

	it('picks the chain back up at the next place somebody has named', () => {
		const blank = row({ id: 'blank', start_min: 700, end_min: 740 });
		const later = at(PLACE.istanbulMosque, { id: 'later', start_min: 900, end_min: 960 });
		const legs = planDay(
			{ day: '2026-04-16', events: [acro, blank, port, later], incoming: [] },
			ROSTER
		);
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([['port', 'later']]);
	});

	it('plans a day that crosses a zone change from local minutes alone', () => {
		// Athens in the morning, a hand-entered flight that lands in Istanbul, and
		// dinner there. The minutes are each city's own local clock; nothing here
		// consults a zone, and nothing needs to, because a journey is planned
		// between two stops on one board.
		const flight = at(PLACE.athensPort, {
			id: 'flight',
			type: 'travel',
			start_min: 780,
			end_min: 900,
			lat: PLACE.istanbulMosque[0],
			lng: PLACE.istanbulMosque[1]
		});
		const dinner = at(PLACE.istanbulHotel, { id: 'dinner', start_min: 1080, end_min: 1140 });
		const legs = planDay(
			{ day: '2026-04-16', events: [acro, flight, dinner], incoming: [lastNight] },
			ROSTER
		);
		// Nothing is ever planned *to* a hand-entered journey, but where it lands
		// starts the next leg: hotel -> Acropolis, then Istanbul -> dinner once the
		// flight is over.
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([
			['prev', 'acro'],
			['flight', 'dinner']
		]);
		expect(legs[1].beforeMin).toBe(1080);
		expect(legs[1].afterMin).toBe(900);
	});
});

describe('resolveLeg', () => {
	const leg: PlannedLeg = {
		key: 'a>b>u',
		fromEventId: 'a',
		toEventId: 'b',
		people: [ANA],
		fromLat: PLACE.athensHotel[0],
		fromLng: PLACE.athensHotel[1],
		toLat: PLACE.acropolis[0],
		toLng: PLACE.acropolis[1],
		km: 1.2,
		afterMin: 540,
		beforeMin: 660,
		openEnded: false
	};
	const none: LegOverride = {
		title: null,
		autoMode: null,
		autoMins: null,
		mode: null,
		mins: null
	};

	it('falls back to the straight-line guess when nothing is stored', () => {
		const a = resolveLeg(leg, null);
		const b = resolveLeg(leg, none);
		expect(a).toEqual(b);
		expect(a.manual).toBe(false);
		expect(a.resolvedMins).toBeGreaterThan(0);
	});

	it('prefers what the provider said over the guess', () => {
		const r = resolveLeg(leg, { ...none, autoMode: 'transit', autoMins: 26 });
		expect(r.resolvedMode).toBe('transit');
		expect(r.resolvedMins).toBe(26);
		expect(r.manual).toBe(false);
	});

	it('prefers what a person pinned over both, and says so', () => {
		const r = resolveLeg(leg, { ...none, autoMode: 'transit', autoMins: 26, mode: 'ferry' });
		expect(r.resolvedMode).toBe('ferry');
		expect(r.resolvedMins).toBe(26);
		expect(r.manual).toBe(true);
	});

	it('counts a pinned duration alone as manual', () => {
		expect(resolveLeg(leg, { ...none, mins: 45 }).manual).toBe(true);
		expect(resolveLeg(leg, { ...none, mins: 45 }).resolvedMins).toBe(45);
	});

	it('places the journey against its arrival, and marks one that does not fit', () => {
		expect(resolveLeg(leg, { ...none, mins: 30 })).toMatchObject({
			startMin: 630,
			endMin: 660,
			tight: false
		});
		expect(resolveLeg(leg, { ...none, mins: 300 })).toMatchObject({
			startMin: 540,
			endMin: 660,
			tight: true
		});
	});

	it('runs an open-ended journey forward from its departure and never calls it tight', () => {
		const home = { ...leg, openEnded: true, beforeMin: MIDNIGHT_MIN };
		expect(resolveLeg(home, { ...none, mins: 40 })).toMatchObject({
			startMin: 540,
			endMin: 580,
			tight: false
		});
	});
});

/* ---------------------------------------------- following a suggested time */

describe('suggested times', () => {
	/** The smallest row the reflow reads: an id, a span, and whether it is pinned. */
	const block = (id: string, start: number, end: number, auto = true) => ({
		id,
		type: 'activity' as const,
		start_min: start,
		end_min: end,
		lat: null,
		lng: null,
		people: [],
		time_auto: auto
	});
	const leg = (from: string, to: string, mins: number) => ({
		fromEventId: from,
		toEventId: to,
		resolvedMins: mins
	});

	it('starts a suggested block when the journey to it arrives, keeping its length', () => {
		const moved = reflowAutoTimes(
			[block('museum', 600, 720, false), block('lunch', 720, 780)],
			[leg('museum', 'lunch', 20)]
		);
		expect(moved).toEqual([{ id: 'lunch', startMin: 740, endMin: 800 }]);
	});

	it('leaves a block somebody put somewhere exactly where they put it', () => {
		expect(
			reflowAutoTimes(
				[block('museum', 600, 720, false), block('lunch', 720, 780, false)],
				[leg('museum', 'lunch', 20)]
			)
		).toEqual([]);
	});

	it('pulls a suggested block earlier when the day in front of it shrinks', () => {
		const moved = reflowAutoTimes(
			[block('museum', 600, 660, false), block('lunch', 900, 960)],
			[leg('museum', 'lunch', 15)]
		);
		expect(moved).toEqual([{ id: 'lunch', startMin: 675, endMin: 735 }]);
	});

	it('cascades in one pass, so a run of suggested blocks all follow', () => {
		const moved = reflowAutoTimes(
			[block('museum', 600, 720, false), block('lunch', 720, 780), block('park', 780, 840)],
			[leg('museum', 'lunch', 20), leg('lunch', 'park', 10)]
		);
		expect(moved).toEqual([
			{ id: 'lunch', startMin: 740, endMin: 800 },
			{ id: 'park', startMin: 810, endMin: 870 }
		]);
	});

	it('waits for the last arrival when the group rejoins', () => {
		const moved = reflowAutoTimes(
			[
				block('museum', 600, 660, false),
				block('beach', 600, 700, false),
				block('dinner', 720, 780)
			],
			[leg('museum', 'dinner', 10), leg('beach', 'dinner', 45)]
		);
		expect(moved).toEqual([{ id: 'dinner', startMin: 745, endMin: 805 }]);
	});

	it('leaves the first thing of the morning alone, because it follows nothing', () => {
		// The origin is last night's stay, which is not a block on this day.
		expect(reflowAutoTimes([block('museum', 600, 720)], [leg('hotel', 'museum', 15)])).toEqual([]);
	});

	it('rounds up to the snap a drag uses, never down into the journey', () => {
		const moved = reflowAutoTimes(
			[block('museum', 600, 660, false), block('lunch', 700, 760)],
			[leg('museum', 'lunch', 13)]
		);
		expect(moved[0].startMin).toBe(675);
	});

	it('keeps a block inside the day rather than past midnight', () => {
		const moved = reflowAutoTimes(
			[block('museum', 600, 1400, false), block('lunch', 700, 760)],
			[leg('museum', 'lunch', 90)]
		);
		expect(moved).toEqual([{ id: 'lunch', startMin: 1380, endMin: 1440 }]);
	});

	it('suggests the end of the day so far, and nine in the morning for an empty one', () => {
		expect(suggestStart([])).toBe(9 * 60);
		expect(suggestStart([block('museum', 600, 720), block('lunch', 400, 500)])).toBe(720);
	});
});
