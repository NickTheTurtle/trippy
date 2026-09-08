/**
 * One-off: (re)seed the Athens escape-room trip into the existing dev database.
 * New accounts get it automatically via `seedExampleTrips`; this is for the
 * demo account that already exists on disk.
 *
 *   node scripts/seed-athens.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { seedAthensTrip, ATHENS_TRIP } from '../src/lib/server/seed-athens.ts';

const db = new DatabaseSync('data/app.db');
db.exec('PRAGMA foreign_keys = ON');

const user = db
	.prepare(`SELECT id, name FROM users WHERE email = ?`)
	.get('demo@waypoint.test') as { id: string; name: string } | undefined;
if (!user) throw new Error('demo account not found — start the dev server once first');

// Drop any previous copy (and the placeholder it replaced) so this is idempotent.
const stale = db
	.prepare(`SELECT id FROM trips WHERE organizer_id = ? AND name IN (?, ?)`)
	.all(user.id, ATHENS_TRIP.name, 'Quebec escape rooms') as unknown as { id: string }[];
for (const t of stale) {
	// Seeded companions are single-trip accounts; remove them with the trip.
	db.prepare(
		`DELETE FROM users WHERE password_hash LIKE 'seed:%'
		   AND id IN (SELECT user_id FROM memberships WHERE trip_id = ?)`
	).run(t.id);
	db.prepare(`DELETE FROM trips WHERE id = ?`).run(t.id);
}

const tripId = seedAthensTrip(db, user.id);
console.log(`seeded "${ATHENS_TRIP.name}" as ${tripId} (removed ${stale.length} stale)`);
db.close();
