import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The shared notepad's storage: a trip with no row reads as empty at version 0,
 * a save is a compare-and-set on the version, and the row goes with its trip.
 */

const tempRoot = join(tmpdir(), `trippy-notes-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'notes.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let notes: typeof import('../src/persistence/notes.ts');
let bus: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, notes, bus] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/notes.ts'),
		import('../src/events.ts')
	]);
});

beforeEach(() => {
	bus.closeAll();
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

function fixture() {
	const organizer = auth.createUser(
		`org-${crypto.randomUUID()}@example.test`,
		'ZZ Org',
		'pw123456'
	);
	const member = auth.createUser(`mem-${crypto.randomUUID()}@example.test`, 'ZZ Mem', 'pw123456');
	const tripId = trips.createTrip(organizer.id, {
		name: 'ZZ Notes Trip',
		startDate: '2026-10-10',
		endDate: '2026-10-15',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, organizer.id, 'ZZ Mem', member.email)).toBe('added');
	return { organizer: organizer.id, member: member.id, tripId };
}

function rowCount(tripId: string): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM trip_notes WHERE trip_id = ?`).get(tripId) as {
			n: number;
		}
	).n;
}

describe('trip notes', () => {
	it('reads as empty at version 0 before anyone saves, without writing a row', () => {
		const f = fixture();
		expect(notes.getNotes(f.tripId)).toEqual({
			body: '',
			version: 0,
			updatedAt: null,
			updatedBy: null
		});
		expect(rowCount(f.tripId)).toBe(0);
	});

	it('saves against version 0, then against each version it gets back', () => {
		const f = fixture();
		const first = notes.saveNotes(f.tripId, f.organizer, 'door code 4417\n', 0);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.notes).toMatchObject({
			body: 'door code 4417\n',
			version: 1,
			updatedBy: { id: f.organizer, name: 'ZZ Org' }
		});
		expect(typeof first.notes.updatedAt).toBe('number');

		const second = notes.saveNotes(f.tripId, f.member, '  indented\n\n', 1);
		expect(second.ok && second.notes).toMatchObject({
			body: '  indented\n\n',
			version: 2,
			updatedBy: { id: f.member, name: 'ZZ Mem' }
		});
		expect(notes.getNotes(f.tripId).version).toBe(2);
	});

	it('refuses a stale version and hands back what is stored', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'first', 0);
		const stale = notes.saveNotes(f.tripId, f.member, 'lost?', 0);
		expect(stale).toEqual({ ok: false, reason: 'conflict', notes: notes.getNotes(f.tripId) });
		expect(stale.ok === false && stale.reason === 'conflict' && stale.notes.body).toBe('first');
		// A version from the future is just as stale.
		expect(notes.saveNotes(f.tripId, f.member, 'ahead', 7)).toMatchObject({ reason: 'conflict' });
		// Against a trip with no row, only 0 is current.
		const g = fixture();
		expect(notes.saveNotes(g.tripId, g.member, 'x', 1)).toMatchObject({ reason: 'conflict' });
		expect(rowCount(g.tripId)).toBe(0);
	});

	it('lets only one of two saves against the same version land', () => {
		const f = fixture();
		const a = notes.saveNotes(f.tripId, f.organizer, 'a', 0);
		const b = notes.saveNotes(f.tripId, f.member, 'b', 0);
		expect([a.ok, b.ok]).toEqual([true, false]);
		expect(notes.getNotes(f.tripId)).toMatchObject({ body: 'a', version: 1 });
	});

	it('treats an identical body as a normal write', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'same', 0);
		const again = notes.saveNotes(f.tripId, f.member, 'same', 1);
		expect(again.ok && again.notes).toMatchObject({
			body: 'same',
			version: 2,
			updatedBy: { id: f.member }
		});
	});

	it('publishes notes on a save and nothing on a refusal', () => {
		const f = fixture();
		const seen: string[] = [];
		const sub = bus.subscribe(f.tripId, f.organizer, (e) => seen.push(e.topic));
		expect(sub.ok).toBe(true);
		notes.saveNotes(f.tripId, f.member, 'x', 0);
		notes.saveNotes(f.tripId, f.member, 'y', 0);
		expect(seen).toEqual(['notes']);
	});

	it('refuses a non-member, an over-long body and a bad version', () => {
		const f = fixture();
		const stranger = auth.createUser(`s-${crypto.randomUUID()}@example.test`, 'ZZ S', 'pw123456');
		expect(notes.saveNotes(f.tripId, stranger.id, 'x', 0)).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(notes.saveNotes(f.tripId, f.member, 'n'.repeat(20001), 0)).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(notes.saveNotes(f.tripId, f.member, 'n'.repeat(20000), 0).ok).toBe(true);
		expect(notes.saveNotes(f.tripId, f.member, 'x', 1.5)).toMatchObject({ reason: 'invalid' });
		expect(notes.saveNotes(f.tripId, f.member, 'x', -1)).toMatchObject({ reason: 'invalid' });
	});

	it('keeps the notes when the last editor account is deleted', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.member, 'still here', 0);
		db.prepare(`DELETE FROM users WHERE id = ?`).run(f.member);
		expect(notes.getNotes(f.tripId)).toMatchObject({
			body: 'still here',
			version: 1,
			updatedBy: null
		});
	});

	it('merges a stale save that names its base, and refuses one that does not', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'a\nb', 0);
		notes.saveNotes(f.tripId, f.organizer, 'A\nb', 1);
		expect(notes.saveNotes(f.tripId, f.member, 'a\nB', 1)).toMatchObject({ reason: 'conflict' });
		const merged = notes.saveNotes(f.tripId, f.member, 'a\nB', 1, 'a\nb');
		expect(merged).toMatchObject({
			ok: true,
			merged: true,
			notes: { body: 'A\nB', version: 3, updatedBy: { id: f.member } }
		});
		// A current version with a base is a plain write.
		expect(notes.saveNotes(f.tripId, f.member, 'x', 3, 'A\nB')).toMatchObject({
			ok: true,
			merged: false,
			notes: { body: 'x', version: 4 }
		});
	});

	it('merges at a matching version when the stored body is not the base', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'theirs', 0);
		expect(notes.saveNotes(f.tripId, f.member, 'ours', 1, 'draft')).toMatchObject({
			ok: true,
			merged: true,
			notes: { body: 'ours\ntheirs', version: 2 }
		});
		// Without a base the version alone decides, as before.
		expect(notes.saveNotes(f.tripId, f.member, 'plain', 2)).toMatchObject({
			ok: true,
			merged: false,
			notes: { body: 'plain', version: 3 }
		});
	});

	it('takes a speculative save as is when the store holds its base or priorBase', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'B0', 0);
		// The in-flight save of 'B0\nL1' never landed; the store still holds B0.
		expect(notes.saveNotes(f.tripId, f.member, 'B0\nL1\nL2', 2, 'B0\nL1', 'B0')).toMatchObject({
			ok: true,
			merged: false,
			notes: { body: 'B0\nL1\nL2', version: 2 }
		});
		// Somebody else then saves; the next speculative save merges from priorBase.
		notes.saveNotes(f.tripId, f.organizer, 'B0\nL1\nL2\nX', 2);
		expect(
			notes.saveNotes(f.tripId, f.member, 'B0\nL1\nL2\nL3', 4, 'B0\nL1\nL2\nL3?', 'B0\nL1\nL2')
		).toMatchObject({ ok: true, merged: true, notes: { body: 'B0\nL1\nL2\nL3\nX' } });
		// A priorBase without a base means nothing.
		expect(notes.saveNotes(f.tripId, f.member, 'x', 4, undefined, 'B0')).toEqual({
			ok: false,
			reason: 'invalid'
		});
	});

	it('writes nothing when the merge would be over the limit', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'o'.repeat(15000), 0);
		const res = notes.saveNotes(f.tripId, f.member, 'm'.repeat(10000), 0, '');
		expect(res).toMatchObject({ ok: false, reason: 'too-long', notes: { version: 1 } });
		expect(notes.getNotes(f.tripId).body).toBe('o'.repeat(15000));
	});

	it('refuses a base over the limit', () => {
		const f = fixture();
		expect(notes.saveNotes(f.tripId, f.member, 'x', 0, 'n'.repeat(20001))).toEqual({
			ok: false,
			reason: 'invalid'
		});
	});

	it('goes with its trip', () => {
		const f = fixture();
		notes.saveNotes(f.tripId, f.organizer, 'bye', 0);
		expect(rowCount(f.tripId)).toBe(1);
		expect(trips.deleteTrip(f.tripId, f.organizer)).toBe(true);
		expect(rowCount(f.tripId)).toBe(0);
		expect(notes.getNotes(f.tripId)).toMatchObject({ body: '', version: 0 });
	});
});
