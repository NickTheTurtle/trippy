import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * What the session lookup does with a cookie it should not honour.
 *
 * The API's `session` middleware resolves every request through
 * `getSessionUser` and its `requireUser` gate answers 401 when that returns
 * null, so this is the decision behind every rejected request: a made-up or
 * malformed id is nobody, and a session past its expiry is nobody and is swept
 * from the table on the way out rather than left to be tried again.
 */

const tempRoot = join(tmpdir(), `trippy-session-guard-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'session-guard.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');

beforeAll(async () => {
	[{ db }, auth] = await Promise.all([import('../src/db.ts'), import('../src/infra/auth.ts')]);
});

let userId: string;

beforeEach(() => {
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	userId = auth.createUser('sam@example.test', 'Sam', 'hunter2hunter2').id;
});

afterAll(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

const sessionCount = (): number =>
	(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;

describe('getSessionUser rejects a cookie it should not honour', () => {
	it('returns null for an id that was never issued', () => {
		expect(auth.getSessionUser('not-a-real-session-id')).toBeNull();
	});

	it('returns null for a malformed, empty id', () => {
		expect(auth.getSessionUser('')).toBeNull();
	});

	it('resolves a live session to its user', () => {
		const id = auth.createSession(userId);
		expect(auth.getSessionUser(id)?.id).toBe(userId);
	});

	it('rejects an expired session and deletes it rather than leaving it to retry', () => {
		const id = auth.createSession(userId);
		// Backdate the expiry the way real time passing would.
		db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, id);
		expect(sessionCount()).toBe(1);

		expect(auth.getSessionUser(id)).toBeNull();
		// The stale row is swept on the way out, not left to be tried again.
		expect(sessionCount()).toBe(0);
	});
});
