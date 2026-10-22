import { describe, expect, it } from 'vitest';
import { minsByMode, routeKey, guessLeg, legKey } from '@trippy/core/travel';
import { haversineKm } from '@trippy/core/geo';
import { replanLegs } from '../src/screens/schedule/replan';
import { journeyFields, journeyPin, parseMins } from '../src/screens/schedule/journeys';
import { blockFit, SMALL_LINE, TITLE_LINE } from '../src/screens/schedule/blockFit';
import { buildScheduleMapModel } from '../src/screens/schedule/mapModel';
import { PX_PER_MIN } from '../src/screens/schedule/shared';
import type { BoardDay, EventRow, LegRow } from '../src/screens/schedule/types';

const DAY = '2026-04-17';
const ROSTER = ['ana', 'ben'];

function row(over: Partial<EventRow> & Pick<EventRow, 'id'>): EventRow {
	return {
		day: DAY,
		end_day: null,
		title: over.id,
		type: 'activity',
		start_min: 9 * 60,
		end_min: 10 * 60,
		poi_id: null,
		lodging_id: null,
		place_text: null,
		city_id: null,
		end_city_id: null,
		lat: null,
		lng: null,
		notes: null,
		travel_mode: null,
		people: [],
		version: 1,
		...over
	};
}

const HOTEL = { lat: 37.975, lng: 23.735 };
const MUSEUM = { lat: 37.9685, lng: 23.7286 };
const AGORA = { lat: 37.9747, lng: 23.7223 };
const FAR = { lat: 37.99, lng: 23.76 };

const hotel = row({
	id: 'hotel',
	type: 'stay',
	day: '2026-04-16',
	end_day: '2026-04-19',
	start_min: 15 * 60,
	end_min: 24 * 60,
	...HOTEL
});
const museum = row({ id: 'museum', start_min: 9 * 60, end_min: 11 * 60, ...MUSEUM });
const lunch = row({
	id: 'lunch',
	type: 'food',
	start_min: 11 * 60 + 20,
	end_min: 12 * 60,
	...AGORA
});

function day(legs: LegRow[] = [], events = [museum, lunch]): BoardDay {
	return { day: DAY, city: null, events, stays: [hotel], incoming: [hotel], legs };
}

const into = (legs: LegRow[], id: string) => legs.find((l) => l.toEventId === id) as LegRow;

describe('replanLegs', () => {
	const fresh = replanLegs(day(), null, ROSTER);
	const plain = into(fresh, 'lunch');
	// The stored row the server would send for the museum to lunch walk.
	const routed: LegRow = {
		...plain,
		id: 'leg-1',
		autoMode: 'transit',
		autoMins: 19,
		autoKey: routeKey(
			{ fromLat: MUSEUM.lat, fromLng: MUSEUM.lng, toLat: AGORA.lat, toLng: AGORA.lng },
			'transit'
		)
	};

	it('keeps a routed answer for the two points it was asked about, with its id and day', () => {
		const leg = into(replanLegs(day([routed]), null, ROSTER), 'lunch');
		expect(leg).toMatchObject({ id: 'leg-1', day: DAY, resolvedMode: 'transit', resolvedMins: 19 });
	});

	it('drops the routed answer once the sheet moves the event somewhere else', () => {
		const moved = { ...lunch, ...FAR };
		const leg = into(replanLegs(day([routed]), moved, ROSTER), 'lunch');
		const km = haversineKm(MUSEUM.lat, MUSEUM.lng, FAR.lat, FAR.lng);
		expect(leg.id).toBe('leg-1');
		expect(leg.autoMins).toBeNull();
		expect(leg.resolvedMins).toBe(guessLeg(km).mins);
	});

	it('lets typed minutes pin the journey, and moves the bar and the tight mark with them', () => {
		const base = into(replanLegs(day([routed]), lunch, ROSTER), 'lunch');
		expect(base).toMatchObject({ startMin: 11 * 60 + 1, endMin: 11 * 60 + 20, tight: false });
		const edits = { [routed.key]: { mins: '30' } };
		const leg = into(
			replanLegs(day([routed]), lunch, ROSTER, undefined, undefined, edits),
			'lunch'
		);
		expect(leg).toMatchObject({ resolvedMins: 30, startMin: 11 * 60, tight: true });
	});

	it('re-estimates a mode picked without minutes, unless the routed answer is for it', () => {
		const at = (edit: { mode?: string; mins?: string }) =>
			into(
				replanLegs(day([routed]), lunch, ROSTER, undefined, undefined, { [routed.key]: edit }),
				'lunch'
			).resolvedMins;
		expect(at({ mode: 'walk' })).toBe(minsByMode(routed.km, 'walk'));
		expect(at({ mode: 'transit' })).toBe(19);
		// Minutes cleared while typing read as the mode's estimate too.
		expect(at({ mode: 'walk', mins: '' })).toBe(minsByMode(routed.km, 'walk'));
	});

	it('leaves the timing alone for a journey that was only renamed', () => {
		const edits = { [routed.key]: { title: 'Stroll' } };
		const leg = into(
			replanLegs(day([routed]), lunch, ROSTER, undefined, undefined, edits),
			'lunch'
		);
		expect(leg).toMatchObject({ title: 'Stroll', resolvedMins: 19, mode: null, mins: null });
	});
});

describe('journeyFields', () => {
	const leg = into(replanLegs(day(), null, ROSTER), 'lunch');

	it('shows untouched fields from the journey as it stands', () => {
		expect(journeyFields(leg, undefined)).toEqual({
			title: '',
			mode: leg.resolvedMode,
			mins: String(leg.resolvedMins)
		});
		// A rename does not snapshot the minutes, so they keep following the event.
		const later = { ...leg, resolvedMins: leg.resolvedMins + 7 };
		expect(journeyFields(later, { title: 'x' }).mins).toBe(String(later.resolvedMins));
	});

	it('shows a picked mode at its estimate, and typed minutes as typed', () => {
		expect(journeyFields(leg, { mode: 'drive' }).mins).toBe(String(minsByMode(leg.km, 'drive')));
		expect(journeyFields(leg, { mode: 'drive', mins: '12' }).mins).toBe('12');
		expect(journeyPin(leg, { title: '  ' })).toEqual({ title: null, mode: null, mins: null });
	});

	it('reads minutes as the server stores them', () => {
		expect([
			parseMins('15'),
			parseMins(' 7.4 '),
			parseMins('0'),
			parseMins(''),
			parseMins('x')
		]).toEqual([15, 7, null, null, null]);
		expect(parseMins('99999')).toBe(48 * 60);
	});
});

describe('blockFit', () => {
	const WIDE = 274;
	const NARROW = 98;
	const TIME = '11:20 AM - 12:00 PM';
	const used = (fit: ReturnType<typeof blockFit>) =>
		fit.kind === 'line'
			? TITLE_LINE
			: fit.titleLines * TITLE_LINE + SMALL_LINE + (fit.people ? SMALL_LINE : 0);

	it('never lays out more lines than the block is tall', () => {
		for (let h = 15; h <= 140; h += 0.25) {
			for (const w of [44, NARROW, 140, WIDE]) {
				const fit = blockFit(h, w, 'A rather long title for a short block', TIME);
				expect(fit.padV).toBeGreaterThanOrEqual(0);
				expect(fit.padV * 2 + used(fit)).toBeLessThanOrEqual(h);
			}
		}
	});

	it('stacks a 45 and a 30 minute block, and puts a 20 on one line', () => {
		expect(blockFit(45 * PX_PER_MIN, WIDE, 'Lunch', TIME)).toMatchObject({
			kind: 'stack',
			titleLines: 1,
			people: true
		});
		expect(blockFit(30 * PX_PER_MIN, WIDE, 'Lunch', TIME)).toMatchObject({
			kind: 'stack',
			titleLines: 1,
			people: false
		});
		expect(blockFit(20 * PX_PER_MIN, WIDE, 'Lunch', TIME)).toMatchObject({
			kind: 'line',
			time: true
		});
	});

	it('shows a 15 minute block, or a narrow one, by its title alone', () => {
		expect(blockFit(15 * PX_PER_MIN, WIDE, 'Coffee', TIME)).toMatchObject({
			kind: 'line',
			time: false
		});
		expect(blockFit(20 * PX_PER_MIN, NARROW, 'Coffee', TIME)).toMatchObject({
			kind: 'line',
			time: false
		});
	});

	it('gives a long title its second line before the people', () => {
		const fit = blockFit(48, 120, 'Ancient Agora and the Temple of Hephaestus', TIME);
		expect(fit).toMatchObject({ kind: 'stack', titleLines: 2, people: false });
	});
});

describe('map routes', () => {
	const model = (memberIds: string[], board: BoardDay) =>
		buildScheduleMapModel({
			day: DAY,
			events: board.events,
			stays: board.stays,
			incoming: board.incoming,
			legs: board.legs,
			saved: [],
			city: null,
			memberIds,
			peopleLabel: () => '',
			locked: false
		});
	const point = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

	it('starts the line at the stay the first journey leaves from', () => {
		const board = day();
		board.legs = replanLegs(board, null, ROSTER);
		const { routes, pins } = model(ROSTER, board);
		expect(routes).toHaveLength(1);
		expect(routes[0].points).toEqual([point(HOTEL), point(MUSEUM), point(AGORA)]);
		// The stay's pin is still its own, unnumbered.
		const stayPin = pins.find((p) => p.key === 'stay:hotel');
		expect(stayPin?.number).toBeUndefined();
	});

	it('leads each reader from their own stay, and draws nothing for a single stop', () => {
		const flat = row({
			id: 'flat',
			type: 'stay',
			day: '2026-04-16',
			end_day: '2026-04-19',
			people: ['ben'],
			...FAR
		});
		const anaHotel = { ...hotel, people: ['ana'] };
		const board: BoardDay = {
			...day(),
			stays: [anaHotel, flat],
			incoming: [anaHotel, flat]
		};
		board.legs = replanLegs(board, null, ROSTER);
		expect(model(['ben'], board).routes[0].points[0]).toEqual(point(FAR));
		expect(model(['ana'], board).routes[0].points[0]).toEqual(point(HOTEL));

		const alone = day([], [museum]);
		alone.legs = replanLegs(alone, null, ROSTER);
		expect(alone.legs.some((l) => l.fromEventId === 'hotel')).toBe(true);
		expect(model(ROSTER, alone).routes).toEqual([]);
	});

	it('draws no line back to the stay at the end of the day', () => {
		const board = day();
		board.legs = replanLegs(board, null, ROSTER);
		const points = model(ROSTER, board).routes[0].points;
		expect(points.at(-1)).toEqual(point(AGORA));
		expect(board.legs.every((l) => l.toEventId !== 'hotel')).toBe(true);
		expect(legKey('hotel', 'museum')).toBe(into(board.legs, 'museum').key);
	});
});
