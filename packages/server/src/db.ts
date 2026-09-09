import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { poiKindFromCategory } from '@trippy/core/types';

/**
 * Local persistence via Node's built-in SQLite (no native build step).
 * Production target remains Postgres; the query surface is kept small and
 * plain so it can move later without churn.
 *
 * The path is resolved from the monorepo root rather than `process.cwd()`, so
 * every workspace app opens the same file no matter which directory it was
 * started from. `TRIPPY_DB` overrides it for tests and throwaway databases.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const file = process.env.TRIPPY_DB ?? join(repoRoot, 'data', 'app.db');
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;

	CREATE TABLE IF NOT EXISTS users (
		id            TEXT PRIMARY KEY,
		email         TEXT UNIQUE NOT NULL,
		name          TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		home_tz       TEXT NOT NULL DEFAULT 'UTC',
		created_at    INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS trips (
		id            TEXT PRIMARY KEY,
		organizer_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		dates         TEXT NOT NULL,
		cover         TEXT NOT NULL,
		home_currency TEXT NOT NULL DEFAULT 'USD',
		created_at    INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS memberships (
		trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		role    TEXT NOT NULL DEFAULT 'member',
		PRIMARY KEY (trip_id, user_id)
	);

	CREATE TABLE IF NOT EXISTS trip_invites (
		id         TEXT PRIMARY KEY,
		trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		email      TEXT NOT NULL,
		invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		placeholder_id TEXT REFERENCES users(id) ON DELETE SET NULL,
		created_at INTEGER NOT NULL,
		UNIQUE (trip_id, email)
	);

	CREATE TABLE IF NOT EXISTS cities (
		id       TEXT PRIMARY KEY,
		trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		name     TEXT NOT NULL,
		country  TEXT NOT NULL,
		tz       TEXT NOT NULL,
		arrive   TEXT NOT NULL,
		depart   TEXT NOT NULL,
		lat      REAL,
		lng      REAL,
		sort     INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS tracks (
		id      TEXT PRIMARY KEY,
		trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		day     TEXT NOT NULL,
		name    TEXT NOT NULL,
		color   TEXT NOT NULL,
		sort    INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS schedule_items (
		id           TEXT PRIMARY KEY,
		track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
		title        TEXT NOT NULL,
		type         TEXT NOT NULL DEFAULT 'poi',
		start_min    INTEGER NOT NULL,
		end_min      INTEGER NOT NULL,
		booking      TEXT,
		travel_mode  TEXT,
		travel_mins  INTEGER,
		travel_before_min INTEGER,
		poi_id       TEXT REFERENCES pois(id) ON DELETE SET NULL,
		lat          REAL,
		lng          REAL
	);

	CREATE TABLE IF NOT EXISTS expenses (
		id          TEXT PRIMARY KEY,
		trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		payer_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		description TEXT NOT NULL,
		amount_cents INTEGER NOT NULL,
		currency    TEXT NOT NULL,
		split_mode  TEXT NOT NULL DEFAULT 'even',
		created_at  INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS expense_participants (
		expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
		user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		weight     REAL NOT NULL DEFAULT 1,
		PRIMARY KEY (expense_id, user_id)
	);

	CREATE TABLE IF NOT EXISTS lodging_options (
		id          TEXT PRIMARY KEY,
		trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		city_id     TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
		name        TEXT NOT NULL,
		tag         TEXT NOT NULL DEFAULT '',
		price_cents INTEGER,
		currency    TEXT NOT NULL,
		url         TEXT,
		locked      INTEGER NOT NULL DEFAULT 0,
		created_at  INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS lodging_votes (
		city_id   TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
		user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		option_id TEXT NOT NULL REFERENCES lodging_options(id) ON DELETE CASCADE,
		PRIMARY KEY (city_id, user_id)
	);

	CREATE TABLE IF NOT EXISTS pois (
		id         TEXT PRIMARY KEY,
		trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		city_id    TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
		name       TEXT NOT NULL,
		category   TEXT NOT NULL DEFAULT '',
		notes      TEXT,
		url        TEXT,
		lat        REAL,
		lng        REAL,
		rating       REAL,
		rating_count INTEGER,
		price_level  INTEGER,
		hours        TEXT,
		saved      INTEGER NOT NULL DEFAULT 0,
		kind       TEXT NOT NULL DEFAULT 'attraction' CHECK (kind IN ('attraction', 'food')),
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS poi_votes (
		poi_id  TEXT NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		PRIMARY KEY (poi_id, user_id)
	);

	CREATE TABLE IF NOT EXISTS cost_estimates (
		trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		city_id     TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
		category    TEXT NOT NULL,
		amount_cents INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (trip_id, city_id, category)
	);

	CREATE TABLE IF NOT EXISTS cost_items (
		id           TEXT PRIMARY KEY,
		trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		city_id      TEXT REFERENCES cities(id) ON DELETE CASCADE,
		category     TEXT NOT NULL,
		label        TEXT NOT NULL,
		amount_cents INTEGER NOT NULL DEFAULT 0,
		sort         INTEGER NOT NULL DEFAULT 0,
		created_at   INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS trip_tasks (
		id         TEXT PRIMARY KEY,
		trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		kind       TEXT NOT NULL DEFAULT 'task',
		label      TEXT NOT NULL,
		assignee   TEXT NOT NULL DEFAULT '',
		flag       TEXT,
		done       INTEGER NOT NULL DEFAULT 0,
		sort       INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
	CREATE INDEX IF NOT EXISTS idx_cities_trip ON cities(trip_id);
	CREATE INDEX IF NOT EXISTS idx_invites_email ON trip_invites(email);
	CREATE INDEX IF NOT EXISTS idx_tracks_trip_day ON tracks(trip_id, day);
	CREATE INDEX IF NOT EXISTS idx_items_track ON schedule_items(track_id);
	CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
	CREATE INDEX IF NOT EXISTS idx_eparts_expense ON expense_participants(expense_id);
	CREATE INDEX IF NOT EXISTS idx_lodging_city ON lodging_options(city_id);
	CREATE INDEX IF NOT EXISTS idx_lvotes_option ON lodging_votes(option_id);
	CREATE INDEX IF NOT EXISTS idx_pois_city ON pois(city_id);
	CREATE INDEX IF NOT EXISTS idx_pvotes_poi ON poi_votes(poi_id);
	CREATE INDEX IF NOT EXISTS idx_costs_trip ON cost_estimates(trip_id);
	CREATE INDEX IF NOT EXISTS idx_costitems_trip ON cost_items(trip_id);
	CREATE INDEX IF NOT EXISTS idx_tasks_trip ON trip_tasks(trip_id);
`);

/**
 * Lightweight, idempotent migrations for schemas that already exist on disk.
 * `CREATE TABLE IF NOT EXISTS` never adds columns to an existing table, so new
 * columns are added here guarded by a PRAGMA check.
 */
function columnExists(table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
	return rows.some((r) => r.name === column);
}

function addColumn(table: string, column: string, definition: string): void {
	if (!columnExists(table, column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

// Day-scoped lodging: an option can be pinned to a night range within its city.
addColumn('lodging_options', 'check_in', 'TEXT');
addColumn('lodging_options', 'check_out', 'TEXT');

// Cover image for a discovered place. Holds either a Google Places photo
// resource name (proxied via /api/place-photo so the API key stays server-side)
// or a plain https URL for hand-entered places.
addColumn('pois', 'photo', 'TEXT');

// The same for a lodging option. A voting portal where every choice renders as
// an identical grey icon gives the vote nothing to go on, and the lookup and
// proxy that places already use work here unchanged.
addColumn('lodging_options', 'photo', 'TEXT');

// Marks an expense that records a transfer between two members rather than a
// cost the group shared. It changes only how the row is labelled: a settlement
// has to count towards balances like any other expense, which is the point.
addColumn('expenses', 'settlement', 'INTEGER');

// Cover image for a city, used on the trip cards. Same rules as the other two:
// null means never looked up, the sentinel means looked up and nothing found.
addColumn('cities', 'photo', 'TEXT');

// Trip dates were originally a free-text label. Keep the label (it is what the
// header renders) but store the real endpoints so the edit form can round-trip
// date pickers instead of asking people to retype a formatted string.
addColumn('trips', 'start_date', 'TEXT');
addColumn('trips', 'end_date', 'TEXT');

// Backfill trip endpoints from the itinerary, which is the real source of truth
// for when a trip runs.
db.exec(`
	UPDATE trips SET
		start_date = (SELECT MIN(arrive) FROM cities WHERE cities.trip_id = trips.id),
		end_date   = (SELECT MAX(depart) FROM cities WHERE cities.trip_id = trips.id)
	WHERE start_date IS NULL
	  AND EXISTS (SELECT 1 FROM cities WHERE cities.trip_id = trips.id)
`);

// Uneven expense splits: participants carry a weight (1 for an even split, a
// share count, or a stated amount in cents), and the expense records which of
// those the weight means so the form can round-trip.
addColumn('expenses', 'split_mode', "TEXT NOT NULL DEFAULT 'even'");
addColumn('expense_participants', 'weight', 'REAL NOT NULL DEFAULT 1');

db.exec(`
	-- Who is doing a given scheduled activity (many members per item, and an
	-- item may be shared / "combined" across people).
	CREATE TABLE IF NOT EXISTS item_assignees (
		item_id TEXT NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		PRIMARY KEY (item_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_item_assignees_item ON item_assignees(item_id);
	CREATE INDEX IF NOT EXISTS idx_item_assignees_user ON item_assignees(user_id);
`);

/**
 * Pre-trip tasks are per-person, not per-trip. Something like "apply for a
 * visa" isn't done when one person does it; every assignee has to do their
 * own. So assignees are rows, and each assignee carries their own completion.
 *
 * `trip_tasks.assignee` (a comma-joined display string) stays as the fallback
 * for tasks nobody is assigned to, which keep the single shared `done` flag.
 */
db.exec(`
	CREATE TABLE IF NOT EXISTS task_assignees (
		task_id TEXT NOT NULL REFERENCES trip_tasks(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		PRIMARY KEY (task_id, user_id)
	);
	CREATE TABLE IF NOT EXISTS task_done (
		task_id TEXT NOT NULL REFERENCES trip_tasks(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		done_at INTEGER NOT NULL,
		PRIMARY KEY (task_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
	CREATE INDEX IF NOT EXISTS idx_task_done_task ON task_done(task_id);
`);

// Backfill: the old assignee column held member *names*, joined by ", ".
// Match them back to real users through the trip's membership so existing
// tasks keep their people. Runs once; after this, rows exist and the
// NOT EXISTS guard makes it a no-op.
db.exec(`
	INSERT OR IGNORE INTO task_assignees (task_id, user_id)
	SELECT t.id, u.id
	FROM trip_tasks t
	JOIN memberships m ON m.trip_id = t.trip_id
	JOIN users u ON u.id = m.user_id
	WHERE t.assignee <> ''
	  AND (', ' || t.assignee || ', ') LIKE ('%, ' || u.name || ', %')
	  AND NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id)
`);

// A task that was already ticked keeps that meaning: everyone assigned is done.
db.exec(`
	INSERT OR IGNORE INTO task_done (task_id, user_id, done_at)
	SELECT a.task_id, a.user_id, 0
	FROM task_assignees a
	JOIN trip_tasks t ON t.id = a.task_id
	WHERE t.done = 1
`);

/**
 * Parties ("crews"): the multi-schedule model. A party groups tracks; its
 * membership is time-segmented so a person can split off (and re-merge) within a
 * day. Every trip has an implicit "Everyone" party: when a (user, day) has no
 * membership segment covering a moment, they are treated as part of Everyone.
 */
db.exec(`
	CREATE TABLE IF NOT EXISTS parties (
		id         TEXT PRIMARY KEY,
		trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		name       TEXT NOT NULL,
		color      TEXT NOT NULL,
		is_solo    INTEGER NOT NULL DEFAULT 0,
		is_default INTEGER NOT NULL DEFAULT 0,
		sort       INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS party_membership (
		id        TEXT PRIMARY KEY,
		party_id  TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
		user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		day       TEXT NOT NULL,
		start_min INTEGER NOT NULL,
		end_min   INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS party_day (
		party_id          TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
		day               TEXT NOT NULL,
		city_id           TEXT REFERENCES cities(id) ON DELETE SET NULL,
		lodging_option_id TEXT REFERENCES lodging_options(id) ON DELETE SET NULL,
		PRIMARY KEY (party_id, day)
	);

	CREATE INDEX IF NOT EXISTS idx_parties_trip ON parties(trip_id);
	CREATE INDEX IF NOT EXISTS idx_pmember_party ON party_membership(party_id);
	CREATE INDEX IF NOT EXISTS idx_pmember_user_day ON party_membership(user_id, day);
`);

// A track belongs to a party (defaults to the trip's Everyone party).
addColumn('tracks', 'party_id', 'TEXT REFERENCES parties(id) ON DELETE CASCADE');

/**
 * Backfill: ensure every trip has an Everyone party and that existing tracks
 * point at it. Membership is intentionally left empty, because the "no segment means
 * Everyone" fallback covers the default single-group case with zero rows.
 */
function backfillParties(): void {
	const trips = db.prepare(`SELECT id FROM trips`).all() as unknown as { id: string }[];
	const findDefault = db.prepare(
		`SELECT id FROM parties WHERE trip_id = ? AND is_default = 1`
	);
	const insParty = db.prepare(
		`INSERT INTO parties (id, trip_id, name, color, is_solo, is_default, sort, created_at)
		 VALUES (?, ?, 'Everyone', '#2f6d5e', 0, 1, 0, ?)`
	);
	const backfillTracks = db.prepare(
		`UPDATE tracks SET party_id = ? WHERE trip_id = ? AND party_id IS NULL`
	);
	for (const t of trips) {
		let def = findDefault.get(t.id) as { id: string } | undefined;
		if (!def) {
			const id = randomUUID();
			insParty.run(id, t.id, Date.now());
			def = { id };
		}
		backfillTracks.run(def.id, t.id);
	}
}
backfillParties();

/**
 * Item-type vocabulary reconciliation.
 *
 * Two spellings of the same idea were in the tree at once: the shared type
 * declared `meal`, while the server's validator, the API and the calendar's
 * type picker all used `food`. Only seeded rows ever carried `meal`, and no
 * client can produce it or render a label for it, so `food` wins and the stray
 * rows are renamed to it. Additive and idempotent: after the first run nothing
 * matches, and it never touches a row that is already canonical.
 *
 * Canonical set: poi | food | transport | travel | lodging | freetime
 * (exported as ITEM_TYPES from @trippy/core).
 */
db.exec(`UPDATE schedule_items SET type = 'food' WHERE type = 'meal'`);

/**
 * Discover buckets: `pois.kind` is the user-facing filter (`attraction` |
 * `food`), stored rather than derived.
 *
 * `pois.category` is whatever the provider called the venue, so filtering on it
 * means re-classifying free text on every render and getting a different answer
 * as providers change their vocabulary. The bucket is a decision, so it is
 * stored once and can be corrected by hand later.
 *
 * Stays are not a kind: they live in `lodging_options`. The CHECK constraint
 * pins the column to the two legal values at the database level, so no code
 * path can invent a third.
 *
 * The classification backfill runs only on the migration that introduces the
 * column. Re-running the file is safe, and, more importantly, a place someone
 * has since re-bucketed by hand is never silently reclassified back on the next
 * boot.
 */
const poiKindIsNew = !columnExists('pois', 'kind');
addColumn(
	'pois',
	'kind',
	`TEXT NOT NULL DEFAULT 'attraction' CHECK (kind IN ('attraction', 'food'))`
);
if (poiKindIsNew) {
	const rows = db.prepare(`SELECT id, category FROM pois`).all() as unknown as {
		id: string;
		category: string | null;
	}[];
	const setKind = db.prepare(`UPDATE pois SET kind = ? WHERE id = ?`);
	db.exec('BEGIN');
	try {
		// The same classifier the write path uses, so a backfilled row and a newly
		// added one are bucketed identically. Existing rows already default to
		// 'attraction', so only the food ones need writing.
		for (const r of rows) {
			if (poiKindFromCategory(r.category) === 'food') setKind.run('food', r.id);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}
