import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { poiKindFromCategory } from '@trippy/core/types';
import { formatDayRange } from '@trippy/core/tz';

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
		lat      REAL,
		lng      REAL,
		sort     INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS events (
		id         TEXT PRIMARY KEY,
		trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		day        TEXT NOT NULL,
		title      TEXT NOT NULL,
		type       TEXT NOT NULL DEFAULT 'activity',
		start_min  INTEGER NOT NULL,
		end_min    INTEGER NOT NULL,
		-- Retired. Nothing reads or writes it: the only way to set a booking state
		-- was a click-to-cycle pill, which was removed as an interaction nobody
		-- wanted. Kept because migrations here are additive, and dropping a column
		-- rewrites the table for no gain.
		booking    TEXT,
		poi_id     TEXT REFERENCES pois(id) ON DELETE SET NULL,
		lodging_id TEXT REFERENCES lodging_options(id) ON DELETE SET NULL,
		city_id    TEXT REFERENCES cities(id) ON DELETE SET NULL,
		lat        REAL,
		lng        REAL,
		notes      TEXT,
		travel_mode TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS event_people (
		event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
		user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		PRIMARY KEY (event_id, user_id)
	);

	CREATE TABLE IF NOT EXISTS travel_legs (
		id            TEXT PRIMARY KEY,
		trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		day           TEXT NOT NULL,
		leg_key       TEXT NOT NULL,
		from_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
		to_event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
		people        TEXT NOT NULL,
		auto_mode     TEXT,
		auto_mins     INTEGER,
		mode          TEXT,
		mins          INTEGER,
		UNIQUE (trip_id, day, leg_key)
	);

	CREATE TABLE IF NOT EXISTS crews (
		id      TEXT PRIMARY KEY,
		trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		name    TEXT NOT NULL,
		color   TEXT NOT NULL,
		sort    INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS crew_members (
		crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		PRIMARY KEY (crew_id, user_id)
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

	-- A registration that has been asked for but not yet proven. The account
	-- does not exist until the emailed link is opened, so an address nobody
	-- controls can never own one. Keyed by email rather than by id, so asking
	-- twice replaces the first attempt instead of leaving two live links.
	--
	-- Only the token's SHA-256 is stored. A stolen database then yields no
	-- usable link, which matters more here than anywhere else in the schema:
	-- this token mints an account, and the reset token below takes one over.
	CREATE TABLE IF NOT EXISTS pending_registrations (
		email         TEXT PRIMARY KEY,
		name          TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		token_hash    TEXT NOT NULL,
		home_tz       TEXT NOT NULL DEFAULT 'UTC',
		expires_at    INTEGER NOT NULL,
		created_at    INTEGER NOT NULL
	);

	-- A password reset in flight. Not keyed by user, because asking twice from
	-- two devices should leave both links working: the row is consumed on use,
	-- and every row for the user is dropped once one of them succeeds.
	CREATE TABLE IF NOT EXISTS password_resets (
		token_hash TEXT PRIMARY KEY,
		user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
	CREATE INDEX IF NOT EXISTS idx_cities_trip ON cities(trip_id);
	CREATE INDEX IF NOT EXISTS idx_invites_email ON trip_invites(email);
	CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
	CREATE INDEX IF NOT EXISTS idx_pending_token ON pending_registrations(token_hash);
	CREATE INDEX IF NOT EXISTS idx_events_trip_day ON events(trip_id, day);
	CREATE INDEX IF NOT EXISTS idx_event_people_event ON event_people(event_id);
	CREATE INDEX IF NOT EXISTS idx_event_people_user ON event_people(user_id);
	CREATE INDEX IF NOT EXISTS idx_legs_trip_day ON travel_legs(trip_id, day);
	CREATE INDEX IF NOT EXISTS idx_crews_trip ON crews(trip_id);
	CREATE INDEX IF NOT EXISTS idx_crew_members_crew ON crew_members(crew_id);
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

function dropColumn(table: string, column: string): void {
	if (columnExists(table, column)) {
		db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
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

// Where the stay is. A place has always kept the provider's coordinates; a stay
// did not need them while it was only ever voted on, and does now that it can
// be booked onto the calendar: the morning's first journey starts from the bed.
// Null for every stay proposed before this, and for one typed by hand.
addColumn('lodging_options', 'lat', 'REAL');
addColumn('lodging_options', 'lng', 'REAL');

// Marks an expense that records a transfer between two members rather than a
// cost the group shared. It changes only how the row is labelled: a settlement
// has to count towards balances like any other expense, which is the point.
addColumn('expenses', 'settlement', 'INTEGER');

// Cover image for a city, used on the trip cards. Same rules as the other two:
// null means never looked up, the sentinel means looked up and nothing found.
addColumn('cities', 'photo', 'TEXT');

// State / province of a city, so two cities that share a name in the same
// country stay distinguishable after they are saved. Nullable with no default:
// rows written before this column existed genuinely have no region, and we
// cannot retroactively know which Springfield someone meant, so NULL is the
// honest value rather than a placeholder.
addColumn('cities', 'region', 'TEXT');

// Trip dates were originally a free-text label. Keep the label (it is what the
// header renders) but store the real endpoints so the edit form can round-trip
// date pickers instead of asking people to retype a formatted string.
addColumn('trips', 'start_date', 'TEXT');
addColumn('trips', 'end_date', 'TEXT');

// Dates are required now, so the free-text "Dates TBD" label has nowhere left
// to come from. Rows written while dates were optional are anchored to the day
// the trip was created: it invents no travel plan, it is traceable to something
// real, and the organizer can correct it in one edit. Both endpoints get the
// same day, which is a valid one-day trip rather than a range nobody chose.
//
// The `dates` label is now always derived from the endpoints, so this also
// repairs rows whose free-text label had drifted away from them. It only writes
// where the two actually disagree, so a normal boot touches nothing.
//
// The columns stay nullable. Tightening them to NOT NULL means rebuilding a
// table that several others reference by foreign key, which is not worth the
// risk when `createTrip` and `updateTrip` are the only writers and both now
// reject a blank date.
{
	const rows = db
		.prepare(`SELECT id, created_at, start_date, end_date, dates FROM trips`)
		.all() as unknown as {
		id: string;
		created_at: number;
		start_date: string | null;
		end_date: string | null;
		dates: string;
	}[];
	const fix = db.prepare(`UPDATE trips SET start_date = ?, end_date = ?, dates = ? WHERE id = ?`);
	for (const trip of rows) {
		const created = new Date(trip.created_at).toISOString().slice(0, 10);
		const start = trip.start_date ?? created;
		const end = trip.end_date ?? start;
		const label = formatDayRange(start, end);
		if (start !== trip.start_date || end !== trip.end_date || label !== trip.dates) {
			fix.run(start, end, label, trip.id);
		}
	}
}

// Cities are places in the itinerary, not dated schedule spans. The trip's
// start and end stay on trips; a day's city now comes from the events on it.
dropColumn('cities', 'arrive');
dropColumn('cities', 'depart');

// Uneven expense splits: participants carry a weight (1 for an even split, a
// share count, or a stated amount in cents), and the expense records which of
// those the weight means so the form can round-trip.
addColumn('expenses', 'split_mode', "TEXT NOT NULL DEFAULT 'even'");
addColumn('expense_participants', 'weight', 'REAL NOT NULL DEFAULT 1');

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

// A packing item is one person's own bag, so it carries no roster: it is a
// list you tick, not work to hand out. Rows an earlier version wrote (or the
// backfill above matched out of the display column) collapse back into the
// shared flag, and an item everyone had ticked stays ticked. Clearing
// `assignee` is what stops the backfill from writing them again on next boot.
db.exec(`
	UPDATE trip_tasks SET done = 1
	 WHERE kind = 'packing' AND done = 0
	   AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = trip_tasks.id)
	   AND NOT EXISTS (
	     SELECT 1 FROM task_assignees a
	      WHERE a.task_id = trip_tasks.id
	        AND NOT EXISTS (
	          SELECT 1 FROM task_done d WHERE d.task_id = a.task_id AND d.user_id = a.user_id));
	DELETE FROM task_done WHERE task_id IN (SELECT id FROM trip_tasks WHERE kind = 'packing');
	DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM trip_tasks WHERE kind = 'packing');
	UPDATE trip_tasks SET assignee = '' WHERE kind = 'packing' AND assignee <> '';
`);

// A packing list is one person's own, not the group's: what you pack is nobody
// else's business and a list of twenty people's socks is nobody's list at all.
// `owner_id` is who it belongs to. Null is the trip's own row, which is what a
// task stays, so the column is additive and tasks are untouched by it.
addColumn('trip_tasks', 'owner_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
db.exec(`CREATE INDEX IF NOT EXISTS idx_trip_tasks_owner ON trip_tasks(trip_id, kind, owner_id)`);

// Nobody loses what they had: an item from the shared era becomes everyone's
// own copy of that item, carrying the tick it already had. The first member
// takes the original row so its id survives, and the rest get copies. Written
// in TypeScript rather than SQL because each copy needs an id of its own.
{
	const shared = db
		.prepare(
			`SELECT id, trip_id, label, flag, done, sort, created_at FROM trip_tasks
		           WHERE kind = 'packing' AND owner_id IS NULL`
		)
		.all() as unknown as {
		id: string;
		trip_id: string;
		label: string;
		flag: string | null;
		done: number;
		sort: number;
		created_at: number;
	}[];
	if (shared.length > 0) {
		const membersOf = db.prepare(`SELECT user_id FROM memberships WHERE trip_id = ?`);
		const claim = db.prepare(`UPDATE trip_tasks SET owner_id = ? WHERE id = ?`);
		const copy = db.prepare(
			`INSERT INTO trip_tasks (id, trip_id, kind, label, assignee, flag, done, sort, created_at, owner_id)
			 VALUES (?, ?, 'packing', ?, '', ?, ?, ?, ?, ?)`
		);
		const drop = db.prepare(`DELETE FROM trip_tasks WHERE id = ?`);
		db.exec('BEGIN');
		try {
			for (const row of shared) {
				const members = membersOf.all(row.trip_id) as unknown as { user_id: string }[];
				// A trip with no members left has nobody to give the item to.
				if (members.length === 0) {
					drop.run(row.id);
					continue;
				}
				claim.run(members[0].user_id, row.id);
				for (const m of members.slice(1)) {
					copy.run(
						randomUUID(),
						row.trip_id,
						row.label,
						row.flag,
						row.done,
						row.sort,
						row.created_at,
						m.user_id
					);
				}
			}
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	}
}

// A cost estimate is a guess at what something will cost, and who it is for is
// part of the guess: a rental car everyone shares and one person's museum pass
// are not the same line. No rows means the whole trip, the way an unassigned
// task means anyone, so an estimate written before the roster exists still
// counts for everybody.
db.exec(`
	CREATE TABLE IF NOT EXISTS cost_item_people (
		item_id TEXT NOT NULL REFERENCES cost_items(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		PRIMARY KEY (item_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_cost_item_people_item ON cost_item_people(item_id);
`);
/**
 * Retiring tracks, parties and their day-segmented membership.
 *
 * The schedule used to be a set of named lanes per day, with a "party" grouping
 * lanes and a membership row saying which minutes of which day a person
 * belonged to which party. Three tables and a time-segmented join existed to
 * answer one question: who is at this event? Events answer it directly, and
 * everything that was derived from lanes (travel, splits, rejoins) is derived
 * from the people on the events instead.
 *
 * This is the one destructive migration in the file. Everything else here is
 * additive because it has to be: the database holds real trips. Schedules were
 * the exception the owner named explicitly, being both disposable and
 * unconvertible, since a lane carries no record of who was walking down it.
 * Crews survive in name only; the new `crews` table is a saved group of people
 * with no schedule of its own, so there is nothing in a party worth carrying
 * across.
 *
 * Ordered children first, because the foreign keys point upwards and
 * `PRAGMA foreign_keys` is on.
 */
for (const table of [
	'item_assignees',
	'schedule_items',
	'tracks',
	'party_membership',
	'party_day',
	'parties'
]) {
	db.exec(`DROP TABLE IF EXISTS ${table}`);
}

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

/**
 * Optimistic concurrency for the two records several people edit at once.
 *
 * A task and an expense are both replaced wholesale by a PUT built from
 * whatever the client last read. With more than one person on a trip that is a
 * lost update waiting to happen: two members open the same task, one retitles
 * it, the other adds themselves to it, and whichever request lands second
 * silently reinstates the first one's old field. Both got a 200.
 *
 * `version` starts at 1 and is bumped by every successful write. A client sends
 * back the version it read, and a write whose version no longer matches is
 * refused rather than applied. The alternative, merging per column, cannot work
 * here: the roster of a task and the split of an expense are sets, and "both
 * edits applied" is not defined for a set that two people rewrote differently.
 * Refusing and telling the loser what happened is the honest outcome.
 */
addColumn('trip_tasks', 'version', 'INTEGER NOT NULL DEFAULT 1');
addColumn('expenses', 'version', 'INTEGER NOT NULL DEFAULT 1');

/**
 * Idempotency for recording a payment.
 *
 * "Mark paid" used to write a row unconditionally, so pressing it twice, which
 * is what people do when the first press looks like it did nothing, recorded
 * the payment twice and inverted the debt it was clearing. The second press was
 * indistinguishable from a genuine second payment of the same amount, because
 * nothing about the request said which suggested transfer it was answering.
 *
 * The server now issues a token with each suggested transfer, derived from the
 * ledger state that produced it, and the client sends it back. Two presses of
 * the same suggestion carry the same token and collapse into one row; a real
 * second payment is quoted against a ledger that now includes the first, so it
 * gets a different token and is recorded normally.
 *
 * Unique per trip rather than globally: the token is only meaningful inside the
 * trip whose ledger produced it. NULL for every ordinary expense, and SQLite
 * treats NULLs as distinct in a unique index, so the constraint applies only to
 * the settlements that carry one.
 */
addColumn('expenses', 'settle_token', 'TEXT');
db.exec(
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_settle_token
	   ON expenses(trip_id, settle_token) WHERE settle_token IS NOT NULL`
);

// The currency an estimate was typed in, so a hotel quoted in yen can be
// entered in yen instead of converted by hand before it is written down.
//
// Empty string rather than the trip's home currency as the default, and it
// means "home". Rows written before this column existed were typed in the home
// currency, so that is already the right reading of them, and an empty value
// keeps following the trip if the organizer later changes the home currency,
// which is what someone who never picked a currency would expect. `lodging`
// has read its currency column this way since it was added.
addColumn('cost_items', 'currency', `TEXT NOT NULL DEFAULT ''`);

/**
 * The exchange rate an expense was recorded at, and the home currency it was
 * recorded against.
 *
 * Balances used to be recomputed from today's rates on every read, so a €920
 * dinner was worth a different number of dollars each time the page loaded and
 * a settled-up trip could quietly fall back out of balance months later. Every
 * expense tool locks the rate to the transaction instead, which is what these
 * two columns do: `fx_rate` is units of home currency per unit of the expense's
 * own currency, captured when the expense was written.
 *
 * `fx_home` records which currency the rate targets, because a trip's home
 * currency can be changed after the fact. A stored rate is only used while it
 * still matches; when it does not, the reader falls back to a live conversion
 * and the next edit re-locks it.
 *
 * NULL on both for rows written before this existed, which read live as they
 * always have.
 */
addColumn('expenses', 'fx_rate', 'REAL');
addColumn('expenses', 'fx_home', 'TEXT');

/**
 * Provider caches, on disk rather than in memory.
 *
 * Every provider call is billed, and the in-process cache these back is lost on
 * every restart: under `tsx watch` that is dozens of times a day, each one
 * re-buying searches we had already paid for. These tables are a pure cost
 * optimisation and never a source of truth, so anything in them can be deleted
 * at any time and the app only gets slower and dearer, never wrong.
 *
 * `expires_at` is capped by the callers at 30 days, the limit Google's terms put
 * on caching Places content. Both tables are pruned on write.
 */
db.exec(`
	CREATE TABLE IF NOT EXISTS provider_cache (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS photo_cache (
		key          TEXT PRIMARY KEY,
		bytes        BLOB NOT NULL,
		content_type TEXT NOT NULL,
		expires_at   INTEGER NOT NULL
	);
`);

/**
 * A journey can be named.
 *
 * An automatic leg and a hand-entered travel event used to be two different
 * kinds of thing on the board: one was a derived sliver with a mode and a
 * duration, the other a block you could title. They describe the same act, so
 * they are now drawn the same way, and a leg needs somewhere to keep the name
 * that goes on it. NULL means "no name of its own", and the board falls back to
 * the mode and the place it arrives at, which is what it always showed.
 */
addColumn('travel_legs', 'title', 'TEXT');

/**
 * A stay ends on its own day.
 *
 * A stay used to be the one event spanning midnight: its `end_min` was a
 * checkout time on the following morning, so `end_min < start_min` was the
 * normal shape and the board drew every stay twice. That model could not say
 * that half the group is in one hotel and half in another, because the second
 * copy of it was a band over the whole day rather than a block with people on
 * it. A stay is now an ordinary block, which is exactly what makes it
 * assignable.
 *
 * Rows written under the old model are closed at midnight rather than at their
 * recorded checkout: midnight is where the old board already drew them on their
 * own day, so nothing moves that a reader could see, and no checkout time is
 * invented on a day it did not belong to.
 */
db.exec(`UPDATE events SET end_min = 1440 WHERE type = 'stay' AND end_min <= start_min`);

/**
 * A stay runs over nights, not over one day.
 *
 * Nobody books a hotel one night at a time, and asking for the same lodging
 * five days running produced five blocks that had to be edited five times. A
 * stay now carries the day it is checked out of, so it is one thing the whole
 * time it is true: `day` is the arrival and `end_day` is the departure morning,
 * exclusive, which is the same reading `lodging_options.check_in/check_out`
 * already had.
 *
 * The column is on `events` rather than only on stays because it costs nothing
 * there and NULL is a complete answer for everything else: an ordinary block
 * begins and ends on its own day, and always did.
 *
 * Rows written before this existed cover exactly the night they are on, which
 * is what the board already drew, so they are backfilled to the morning after
 * rather than left NULL. That keeps one rule for reading a stay instead of two.
 */
addColumn('events', 'end_day', 'TEXT');
db.exec(
	`UPDATE events SET end_day = date(day, '+1 day')
	 WHERE type = 'stay' AND end_day IS NULL`
);

/**
 * Optimistic concurrency for schedule events.
 *
 * Tasks and expenses have carried a version for a while, and a stale save on
 * either is refused with a 409. Events were the one collaborative row left
 * without one, which made them the only place where two people editing the same
 * thing ended in silent data loss: one person retitled an event, the other
 * saved a time change from a form still holding the old title, and the retitle
 * was gone with nothing said. Events are the most concurrently edited rows in a
 * group trip planner, so they were the worst possible gap.
 *
 * Existing rows start at 1, the same baseline the other two tables were
 * backfilled to.
 */
addColumn('events', 'version', 'INTEGER NOT NULL DEFAULT 1');

/**
 * A location typed by hand, for somewhere the trip has not saved.
 *
 * Until now an event was somewhere only by linking to a Discover place or to a
 * proposed stay, which is the right default (a link carries coordinates, and
 * coordinates are what the map draws and what the travel chain is planned off)
 * and the wrong constraint. A restaurant the group picks on the pavement has no
 * saved place and is not worth adding to Discover for one meal, and the only
 * way to record it was to abuse the notes.
 *
 * So the column holds a name and nothing else. It is deliberately not
 * geocoded: a lookup per keystroke costs money on a metered provider, and a
 * place the organiser typed as "the tapas place near the square" has no honest
 * coordinates to find. An event with one is therefore named after it but stays
 * off the map and out of the travel chain, exactly as an event with no place at
 * all does today.
 *
 * Exclusive with the two links, and enforced in `editEvent` rather than by a
 * constraint: writing one clears the others, so an event is somewhere for
 * exactly one reason. Existing rows are NULL, which is what they already mean.
 */
addColumn('events', 'place_text', 'TEXT');

/**
 * Addresses we must not mail again, fed by Amazon SES bounce and complaint
 * notifications.
 *
 * Open sign-up means every registration mails whatever a stranger typed, so
 * typos and deliberate garbage produce hard bounces, and a recipient can mark a
 * real message as spam. AWS suspends a sending identity that drifts past roughly
 * a 5% bounce or 0.1% complaint rate, and that identity is the owner's whole
 * `dxu.info` domain, not just this app. This table is the record `sendMail`
 * consults so a known-bad address is never mailed a second time.
 *
 * A brand-new table rather than a column, so the migration is additive by
 * construction: `CREATE TABLE IF NOT EXISTS` adds it on an existing database and
 * touches no existing row. Keyed by the lowercased address, which is the form
 * everything else stores and looks up by.
 *
 *  - `reason` is `bounce` (permanent), `soft_bounce` (transient, time-limited)
 *    or `complaint`.
 *  - `subtype` records the SES distinction that the suppression decision turns
 *    on: `Permanent`, `Transient` or `Undetermined` for a bounce, or the
 *    complaint feedback type when SES supplies one. NULL when the notification
 *    carried none.
 *  - `created_at` is when we recorded it, in epoch milliseconds like every other
 *    timestamp in this schema.
 */
db.exec(`
	CREATE TABLE IF NOT EXISTS mail_suppressions (
		email      TEXT PRIMARY KEY,
		reason     TEXT NOT NULL,
		subtype    TEXT,
		created_at INTEGER NOT NULL
	);
`);

/**
 * One row per data backfill that must run exactly once on an existing database.
 *
 * A schema migration here is a column or a table, and both are idempotent by
 * construction: `ALTER TABLE ... ADD COLUMN` is guarded by a PRAGMA check and
 * `CREATE TABLE IF NOT EXISTS` does nothing twice. A backfill is neither. It
 * rewrites rows, it can be expensive, and it belongs to the module that owns
 * the rows rather than to this file, which is why the marker lives here and the
 * work does not.
 *
 * Additive like everything else: a new table, no existing row touched, and a
 * database that has never seen a backfill simply has none recorded.
 */
db.exec(`
	CREATE TABLE IF NOT EXISTS schema_backfills (
		name    TEXT PRIMARY KEY,
		done_at INTEGER NOT NULL
	);
`);

/** Has this one-time backfill already run against this database? */
export function backfillDone(name: string): boolean {
	return !!db.prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`).get(name);
}

/** Record a one-time backfill as done, so it never runs a second time. */
export function markBackfillDone(name: string): void {
	db.prepare(`INSERT OR REPLACE INTO schema_backfills (name, done_at) VALUES (?, ?)`).run(
		name,
		Date.now()
	);
}

/**
 * The day an expense happened, as opposed to the instant it was typed in.
 *
 * `created_at` is a keystroke timestamp, and it was the only date an expense
 * had. That is fine while everyone enters things as they go and wrong the
 * moment anybody catches up: a week of receipts reconciled on the flight home
 * all landed on the same day, in the order they were typed, and no screen could
 * say otherwise because there was nothing to say it with. `spent_on` is the
 * date a person picks, and it is what the ledger is ordered by.
 *
 * TEXT `YYYY-MM-DD`, matching `trips.start_date/end_date`, `events.day` and
 * `lodging_options.check_in/check_out`, rather than an epoch integer like
 * `created_at`. The two columns are answering different questions and deserve
 * different types. An instant is a point on the world's clock and only means
 * something with a zone attached; a calendar day is what a human picked off a
 * date picker and has no zone at all. A trip crosses zones by definition, so
 * storing this as an instant forces a zone choice on every read, and there is
 * no right one: a 9pm Tokyo dinner stored as an instant renders as the previous
 * day in London, and the same row would name two different dates depending on
 * who was looking. Storing the plain day means the dinner the group had on the
 * 14th is on the 14th for every member, forever, which is what everyone who was
 * at that dinner means by its date. This is the same boundary `@trippy/core/tz`
 * already draws, and `isDayString` / `normalizeDay` there are the validators
 * for this column too.
 *
 * Deliberately descriptive only: it drives ordering and display and must never
 * touch `fx_rate`. The rate is locked at entry time and the provider serves
 * only current rates, so a date change cannot be honoured with a historical
 * rate; pretending otherwise would silently revalue a backdated expense and
 * move every member's settled balance under them. See `docs/DESIGN.md` §M7.
 *
 * Existing rows are backfilled from `created_at` rather than left NULL, so
 * every expense in the table has a real date and readers need one rule, not
 * two. The UTC day of the keystroke is the honest answer for them: it is the
 * only fact we have about when they happened, it is what the `trips` backfill
 * above already derives from `created_at`, and it is off by at most a day for
 * anyone who was entering expenses near midnight in a distant zone, which a
 * member can correct in one edit.
 *
 * The column stays nullable for the same reason the `trips` endpoints did:
 * tightening to NOT NULL means rebuilding a table that `expense_participants`
 * references by foreign key, which is not worth the risk when `addExpense` and
 * `updateExpense` are the only writers and both always supply a value.
 */
addColumn('expenses', 'spent_on', 'TEXT');
db.exec(
	`UPDATE expenses SET spent_on = date(created_at / 1000, 'unixepoch') WHERE spent_on IS NULL`
);

/**
 * A suppression that ends by itself, and the count of soft failures behind it.
 *
 * The first cut of this table recorded only what must never be mailed again,
 * which meant a transient bounce (a full mailbox, a greylisting mail server, an
 * hour of downtime at the recipient's provider) had nowhere to go and was simply
 * dropped. That is safe for the user and bad for the identity: SES counts every
 * one of those retries in the bounce rate, and nothing in the app could see that
 * an address had failed nine times this week.
 *
 *  - `expires_at` is epoch milliseconds, or NULL for a suppression that never
 *    lifts. NULL is the default, so every row written before this column existed
 *    keeps exactly the meaning it had: a hard bounce or a complaint, permanent.
 *    A soft bounce writes a real timestamp and stops blocking once it passes,
 *    which is what keeps a temporary failure from locking a real person out of
 *    their own account for good.
 *  - `soft_count` is how many soft bounces this address has accumulated, so
 *    repeated transient failure can escalate to a permanent suppression instead
 *    of retrying forever. Existing rows default to 0: they were never soft.
 *
 * Both are `ALTER TABLE ... ADD COLUMN` through the guarded helper above, so
 * this is additive and idempotent like every other migration in this file, and
 * an existing populated database keeps every row it had.
 */
addColumn('mail_suppressions', 'expires_at', 'INTEGER');
addColumn('mail_suppressions', 'soft_count', 'INTEGER NOT NULL DEFAULT 0');

/**
 * The last thing each paid provider did: succeed, or fail and how.
 *
 * `/api/health` reports whether Google is actually answering, and it used to
 * learn that only from failures recorded in the current process. The API runs
 * under `tsx watch`, so every saved file restarts it and wipes that memory, and
 * the endpoint whose job is to say what is broken went back to reporting green
 * until the next user happened to search. A monitor polling it saw green through
 * an outage.
 *
 * One row per service (`places`, `routing`), holding when it last succeeded and
 * what the most recent failure was. It is deliberately not a cache: a row here
 * is the only evidence that survives a restart, so it is written on a state
 * change rather than given a TTL. Nothing here is a secret; `fail_reason` is a
 * status code or a transport reason, never a key and never a full query (see
 * `provider-health.ts`).
 *
 * A brand-new table, so the migration is additive by construction: an existing
 * database gains it and no existing row is touched. An empty table reads as "no
 * failure recorded", which is the same state a fresh process was always in.
 */
db.exec(`
	CREATE TABLE IF NOT EXISTS provider_health (
		service     TEXT PRIMARY KEY,
		ok_at       INTEGER NOT NULL DEFAULT 0,
		fail_at     INTEGER,
		fail_op     TEXT,
		fail_reason TEXT,
		fail_count  INTEGER NOT NULL DEFAULT 0
	);
`);
