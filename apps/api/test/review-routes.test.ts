import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The route-level fixes from the pre-1.0 review, over HTTP, through the same
 * mount the app uses (`/trips` with every section router under it).
 *
 * Each block is one finding: a refusal that used to be a 500, a silent drop, a
 * misleading status, or a value with no ceiling.
 */

const tempRoot = join(tmpdir(), `trippy-api-review-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let members: typeof import('@trippy/server/members');
let bus: typeof import('@trippy/server/events');
let middleware: typeof import('../src/middleware.ts');
let snapWidth: (w: number) => number;
let app: Hono;

interface Fixture {
	organizer: string;
	member: string;
	cookie: string;
	memberCookie: string;
	tripId: string;
	cityId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, membersMod, busMod, mw, tripRoutes, photoRoutes] =
		await Promise.all([
			import('@trippy/server/db'),
			import('@trippy/server/auth'),
			import('@trippy/server/trips'),
			import('@trippy/server/members'),
			import('@trippy/server/events'),
			import('../src/middleware.ts'),
			import('../src/routes/trips.ts'),
			import('../src/routes/place-photo.ts')
		]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	members = membersMod;
	bus = busMod;
	middleware = mw;
	snapWidth = photoRoutes.snapWidth;

	app = new Hono();
	app.use('*', mw.session);
	app.route('/trips', tripRoutes.trips as unknown as Hono);
});

beforeEach(() => {
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterAll(() => {
	bus.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

// The trip runs 2026-10-10 to 2026-10-15.
function fixture(): Fixture {
	const organizer = auth.createUser(`org-${crypto.randomUUID()}@example.test`, 'ZZ Org', 'pw123456');
	const member = auth.createUser(`mem-${crypto.randomUUID()}@example.test`, 'ZZ Mem', 'pw123456');
	const tripId = trips.createTrip(organizer.id, {
		name: 'ZZ Review Trip',
		startDate: '2026-10-10',
		endDate: '2026-10-15',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, organizer.id, 'ZZ Mem', member.email)).toBe('added');
	const cityId = trips.addCity(tripId, organizer.id, {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens',
		lat: 37.98,
		lng: 23.73
	})!;
	return {
		organizer: organizer.id,
		member: member.id,
		cookie: `session=${auth.createSession(organizer.id)}`,
		memberCookie: `session=${auth.createSession(member.id)}`,
		tripId,
		cityId
	};
}

function send(cookie: string, method: string, path: string, body?: Record<string, unknown>) {
	return app.request(path, {
		method,
		headers: { 'content-type': 'application/json', cookie },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

async function error(res: Response, status = 400): Promise<string> {
	expect(res.status, await res.clone().text()).toBe(status);
	return ((await res.json()) as { error: string }).error;
}

const TRIP_EDIT = {
	name: 'ZZ Review Trip',
	startDate: '2026-10-10',
	endDate: '2026-10-15',
	currency: 'USD'
};

function lockState(tripId: string): number {
	return (
		db.prepare(`SELECT schedule_locked FROM trips WHERE id = ?`).get(tripId) as {
			schedule_locked: number;
		}
	).schedule_locked;
}

describe('organizer refusals are 403, not a 400 that reads like a bad value', () => {
	it('refuses a member editing the trip with 403', async () => {
		const f = fixture();
		const res = await send(f.memberCookie, 'PATCH', `/trips/${f.tripId}`, TRIP_EDIT);
		expect(await error(res, 403)).toBe('Only the organizer can edit this trip.');
	});

	it('refuses a member adding, editing or removing a city with 403', async () => {
		const f = fixture();
		const city = { name: 'Delphi', country: 'Greece', tz: 'Europe/Athens' };
		const cities = `/trips/${f.tripId}/cities`;
		const forbidden = 'Only the organizer can change the cities on this trip.';
		expect(await error(await send(f.memberCookie, 'POST', cities, city), 403)).toBe(forbidden);
		expect(
			await error(await send(f.memberCookie, 'PATCH', `${cities}/${f.cityId}`, city), 403)
		).toBe(forbidden);
		expect(await error(await send(f.memberCookie, 'DELETE', `${cities}/${f.cityId}`), 403)).toBe(
			forbidden
		);
	});

	it('tells a missing city apart from the last one', async () => {
		const f = fixture();
		const cities = `/trips/${f.tripId}/cities`;
		expect((await send(f.cookie, 'DELETE', `${cities}/no-such-city`)).status).toBe(404);
		expect(await error(await send(f.cookie, 'DELETE', `${cities}/${f.cityId}`))).toBe(
			'A trip needs at least one city.'
		);
		const edit = { name: 'Delphi', country: 'Greece', tz: 'Europe/Athens' };
		expect((await send(f.cookie, 'PATCH', `${cities}/no-such-city`, edit)).status).toBe(404);
	});

	it('still names the duplicate city', async () => {
		const f = fixture();
		const res = await send(f.cookie, 'POST', `/trips/${f.tripId}/cities`, {
			name: 'athens ',
			country: 'GREECE',
			tz: 'Europe/Athens'
		});
		expect(await error(res)).toBe('athens is already on this trip.');
	});
});

describe('city time zones are asked of Intl', () => {
	it('refuses a zone-shaped string that is not a zone, and takes UTC', async () => {
		const f = fixture();
		const cities = `/trips/${f.tripId}/cities`;
		const bad = await send(f.cookie, 'POST', cities, {
			name: 'Olympus',
			country: 'Mars',
			tz: 'Mars/Olympus_Mons'
		});
		expect(bad.status).toBe(400);
		const utc = await send(f.cookie, 'POST', cities, { name: 'Null Island', country: 'Sea', tz: 'UTC' });
		expect(utc.status).toBe(201);
	});
});

describe('the schedule lock survives an edit that does not mention it', () => {
	it('keeps the stored lock when scheduleLocked is omitted', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}`;
		expect((await send(f.cookie, 'PATCH', path, { ...TRIP_EDIT, scheduleLocked: true })).status).toBe(
			200
		);
		expect(lockState(f.tripId)).toBe(1);
		expect((await send(f.cookie, 'PATCH', path, { ...TRIP_EDIT, name: 'Renamed' })).status).toBe(200);
		expect(lockState(f.tripId)).toBe(1);
		expect((await send(f.cookie, 'PATCH', path, { ...TRIP_EDIT, scheduleLocked: false })).status).toBe(
			200
		);
		expect(lockState(f.tripId)).toBe(0);
	});
});

describe('currencies are held to the offline table at every write', () => {
	it('refuses a trip in a currency nothing can convert', async () => {
		const f = fixture();
		const create = await send(f.cookie, 'POST', '/trips', {
			name: 'ZZ Dong Trip',
			startDate: '2026-10-10',
			endDate: '2026-10-12',
			homeCurrency: 'AFN'
		});
		expect(await error(create)).toBe('Pick a currency from the list.');
		const edit = await send(f.cookie, 'PATCH', `/trips/${f.tripId}`, { ...TRIP_EDIT, currency: 'XYZ' });
		expect(await error(edit)).toBe('Pick a currency from the list.');
	});

	it('refuses a trip dated outside the day window', async () => {
		const f = fixture();
		const res = await send(f.cookie, 'POST', '/trips', {
			name: 'ZZ Old Trip',
			startDate: '1200-10-10',
			endDate: '1200-10-12',
			homeCurrency: 'USD'
		});
		expect(await error(res)).toBe('Pick a date between 2000 and 2100.');
	});

	it('refuses an expense in an unknown currency with a 400, not a later 500', async () => {
		const f = fixture();
		const expense = {
			description: 'ZZ Dinner',
			amount: 10,
			payerId: f.organizer,
			participantIds: [f.organizer, f.member]
		};
		const path = `/trips/${f.tripId}/expenses`;
		expect(await error(await send(f.cookie, 'POST', path, { ...expense, currency: 'AFN' }))).toBe(
			'Pick a currency from the list.'
		);
		const lower = await send(f.cookie, 'POST', path, { ...expense, currency: 'eur' });
		expect(lower.status).toBe(201);
		const { id } = (await lower.json()) as { id: string };
		const row = db.prepare(`SELECT currency FROM expenses WHERE id = ?`).get(id) as { currency: string };
		expect(row.currency).toBe('EUR');
		// And the ledger still reads.
		expect((await send(f.cookie, 'GET', path)).status).toBe(200);
	});

	it('offers exactly the offline table', async () => {
		const f = fixture();
		const res = await send(f.cookie, 'GET', `/trips/${f.tripId}/expenses`);
		const { currencies } = (await res.json()) as { currencies: string[] };
		expect(currencies).toContain('USD');
		expect(currencies).toContain('BRL');
		expect(currencies).not.toContain('AFN');
	});

	it('refuses an estimate in an unknown currency, and an over-long label', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/pretrip/costs`;
		const item = { category: 'food', label: 'ZZ Snacks', amount: 12 };
		expect(await error(await send(f.cookie, 'POST', path, { ...item, currency: 'AFN' }))).toBe(
			'Pick a currency from the list.'
		);
		expect((await send(f.cookie, 'POST', path, { ...item, label: 'x'.repeat(201) })).status).toBe(400);
		expect((await send(f.cookie, 'POST', path, { ...item, currency: 'jpy' })).status).toBe(201);
		expect((await send(f.cookie, 'POST', path, item)).status).toBe(201);
	});

	it('refuses a stay priced in an unknown currency, on add and on edit', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/discover/stays`;
		const stay = { name: 'ZZ Hotel', cityId: f.cityId, priceCents: 10000 };
		expect(await error(await send(f.cookie, 'POST', path, { ...stay, currency: 'AFN' }))).toBe(
			'Pick a currency from the list.'
		);
		const ok = await send(f.cookie, 'POST', path, { ...stay, currency: 'eur' });
		expect(ok.status).toBe(201);
		const { id } = (await ok.json()) as { id: string };
		const edit = await send(f.cookie, 'PATCH', `${path}/${id}`, { name: 'ZZ Hotel', currency: 'XYZ' });
		expect(await error(edit)).toBe('Pick a currency from the list.');
	});
});

describe('share weights have a ceiling', () => {
	it('refuses an absurd share and takes one at the ceiling', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/expenses`;
		const expense = {
			description: 'ZZ Shares',
			amount: 100,
			payerId: f.organizer,
			participantIds: [f.organizer, f.member],
			splitMode: 'shares'
		};
		const huge = await send(f.cookie, 'POST', path, {
			...expense,
			weights: { [f.organizer]: 1e308, [f.member]: 1e308 }
		});
		expect(await error(huge)).toContain('Keep each share under');
		const atCap = await send(f.cookie, 'POST', path, {
			...expense,
			weights: { [f.organizer]: 1e6, [f.member]: 1 }
		});
		expect(atCap.status).toBe(201);
	});
});

describe('unbounded numbers on places and stays', () => {
	it('holds a stay price to the money ceiling, in cents and in major units', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/discover/stays`;
		const stay = { name: 'ZZ Palace', cityId: f.cityId };
		expect(await error(await send(f.cookie, 'POST', path, { ...stay, priceCents: 1e14 }))).toBe(
			'That amount is too large. Enter a smaller one.'
		);
		expect((await send(f.cookie, 'POST', path, { ...stay, price: 1e12 })).status).toBe(400);
		// Past the safe-integer range is not a count at all.
		expect(await error(await send(f.cookie, 'POST', path, { ...stay, priceCents: 1e21 }))).toBe(
			'Enter a valid price, or leave it blank.'
		);
		expect((await send(f.cookie, 'POST', path, { ...stay, priceCents: 25000 })).status).toBe(201);
	});

	it('holds provider details on a place to their real ranges', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/discover/pois`;
		let n = 0;
		const add = (extra: Record<string, unknown>) =>
			send(f.cookie, 'POST', path, { name: `ZZ Spot ${n++}`, cityId: f.cityId, ...extra });

		expect((await add({ ratingCount: 1e300 })).status).toBe(400);
		expect((await add({ ratingCount: -1 })).status).toBe(400);
		expect((await add({ priceLevel: 40 })).status).toBe(400);
		expect((await add({ rating: 6 })).status).toBe(400);
		expect((await add({ hours: new Array(15).fill('Mon: 9-5') })).status).toBe(400);
		expect((await add({ hours: ['x'.repeat(201)] })).status).toBe(400);
		expect((await add({ photo: 'https://evil.example/x.png' })).status).toBe(400);
		expect((await add({ photo: `places/abc/photos/${'a'.repeat(1100)}` })).status).toBe(400);
		expect(await error(await add({ category: 'x'.repeat(201) }))).toBe('Keep it under 200 characters.');

		const good = await add({
			rating: 4.6,
			ratingCount: 1234,
			priceLevel: 2,
			hours: new Array(7).fill('Monday: 9:00 AM to 5:00 PM'),
			photo: 'places/ChIJabc/photos/AUc7tXV-123_x',
			category: 'Museum'
		});
		expect(good.status).toBe(201);
	});
});

describe('crew names are held to the shared ceiling', () => {
	it('refuses an over-long crew name on create and rename', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/people/crews`;
		expect((await send(f.cookie, 'POST', path, { name: 'x'.repeat(201) })).status).toBe(400);
		const made = await send(f.cookie, 'POST', path, { name: 'ZZ Crew', people: [f.organizer] });
		expect(made.status).toBe(201);
		const { id } = (await made.json()) as { id: string };
		expect((await send(f.cookie, 'PATCH', `${path}/${id}`, { name: 'x'.repeat(201) })).status).toBe(
			400
		);
	});
});

describe('creating an event is held to the same rules as editing one', () => {
	const events = (f: Fixture) => `/trips/${f.tripId}/schedule/events`;
	const base = { day: '2026-10-11', start: 9 * 60, duration: 60, title: 'ZZ Block' };

	it('refuses an unknown type instead of turning it into an activity', async () => {
		const f = fixture();
		expect(await error(await send(f.cookie, 'POST', events(f), { ...base, type: 'party' }))).toBe(
			'Pick an event type.'
		);
		// Absent and blank still mean an activity.
		expect((await send(f.cookie, 'POST', events(f), base)).status).toBe(201);
		expect((await send(f.cookie, 'POST', events(f), { ...base, type: '' })).status).toBe(201);
	});

	it('refuses an unknown travel mode instead of storing none', async () => {
		const f = fixture();
		const res = await send(f.cookie, 'POST', events(f), {
			...base,
			type: 'travel',
			travelMode: 'teleport'
		});
		expect(await error(res)).toBe('Pick a travel mode.');
		const ok = await send(f.cookie, 'POST', events(f), { ...base, type: 'travel', travelMode: 'walk' });
		expect(ok.status).toBe(201);
	});

	it("refuses a city that is not on this trip", async () => {
		const f = fixture();
		const other = fixture();
		const res = await send(f.cookie, 'POST', events(f), { ...base, cityId: other.cityId });
		expect(await error(res)).toBe('Pick a city on this trip.');
		expect((await send(f.cookie, 'POST', events(f), { ...base, cityId: f.cityId })).status).toBe(201);
	});
});

describe('dragging a stay cannot carry its checkout past the trip', () => {
	it('refuses a move whose kept length would check out after the morning after the trip', async () => {
		const f = fixture();
		const made = await send(f.cookie, 'POST', `/trips/${f.tripId}/schedule/events`, {
			day: '2026-10-11',
			endDay: '2026-10-14',
			type: 'stay',
			title: 'ZZ Stay'
		});
		expect(made.status).toBe(201);
		const { id } = (await made.json()) as { id: string };
		const op = (day: string) =>
			send(f.cookie, 'POST', `/trips/${f.tripId}/schedule/events/${id}/op`, {
				op: 'move',
				startMin: 15 * 60,
				day
			});

		// Three nights from the 14th would check out on the 17th.
		expect(await error(await op('2026-10-14'))).toContain('outside the trip');
		const row = () =>
			db.prepare(`SELECT day, end_day FROM events WHERE id = ?`).get(id) as {
				day: string;
				end_day: string;
			};
		expect(row()).toEqual({ day: '2026-10-11', end_day: '2026-10-14' });

		// From the 13th it checks out on the 16th: the last night is the 15th.
		expect((await op('2026-10-13')).status).toBe(200);
		expect(row()).toEqual({ day: '2026-10-13', end_day: '2026-10-16' });
	});
});

describe('journey edits', () => {
	it('refuses an over-long name and an unknown mode before looking the leg up', async () => {
		const f = fixture();
		const path = `/trips/${f.tripId}/schedule/legs/no-such-leg`;
		expect(await error(await send(f.cookie, 'PATCH', path, { title: 'x'.repeat(201) }))).toBe(
			'Keep it under 200 characters.'
		);
		expect(await error(await send(f.cookie, 'PATCH', path, { mode: 'teleport' }))).toBe(
			'Pick a travel mode.'
		);
		expect((await send(f.cookie, 'PATCH', path, { title: 'ZZ Ferry' })).status).toBe(404);
	});
});

describe('live streams per person', () => {
	it('answers a seventh stream from one user with 429 and a Retry-After', async () => {
		const f = fixture();
		const held: import('@trippy/server/events').TripSubscription[] = [];
		for (let i = 0; i < 6; i++) {
			const sub = bus.subscribe(f.tripId, f.organizer, () => undefined);
			expect(sub.ok).toBe(true);
			if (sub.ok) held.push(sub.sub);
		}
		const res = await send(f.cookie, 'GET', `/trips/${f.tripId}/events`);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBeTruthy();
		expect((await res.json()).error).toContain('too many live connections');
		for (const sub of held) sub.close();
	});
});

describe('request bodies have a ceiling', () => {
	it('refuses a body over 256 KB with 413 in the standard envelope', async () => {
		const small = new Hono();
		small.use('/api/*', middleware.limitBody);
		small.post('/api/echo', async (c) => c.json({ size: (await c.req.text()).length }));

		const big = 'x'.repeat(middleware.BODY_LIMIT_BYTES + 1);
		const refused = await small.request('/api/echo', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
			body: big
		});
		expect(refused.status).toBe(413);
		expect(await refused.json()).toEqual({ error: 'That request is too large.' });

		const fine = await small.request('/api/echo', { method: 'POST', body: '{"a":1}' });
		expect(fine.status).toBe(200);
	});
});

describe('place photo widths', () => {
	it('snaps a requested width up to the next bucket', () => {
		expect(snapWidth(1)).toBe(160);
		expect(snapWidth(160)).toBe(160);
		expect(snapWidth(161)).toBe(320);
		expect(snapWidth(318)).toBe(320);
		expect(snapWidth(322)).toBe(640);
		expect(snapWidth(641)).toBe(1200);
		expect(snapWidth(99999)).toBe(1200);
	});
});
