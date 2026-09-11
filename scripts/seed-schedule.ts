/**
 * Re-seed a trip's schedule from the Athens sample, in place.
 *
 * Run with:  npx tsx scripts/seed-schedule.ts [tripId]
 *
 * Replacing tracks with events dropped every scheduled block in the database,
 * which left the demo trip with its people, POIs, votes and expenses intact but
 * an empty board. Rebuilding the trip from scratch would have restored the
 * schedule at the cost of everything else, so this fills the schedule back in
 * and touches nothing else. Without a trip id it picks the newest trip that has
 * enough members for the sample's splits to mean anything.
 *
 * The sample's `who` lists are indices into a roster of 20. Real members are
 * matched to those slots by name, and whoever is left over fills the slots the
 * names did not claim, so every member of the trip ends up on the board even
 * when the trip's roster has drifted from the sample's.
 */
import { db } from '../packages/server/src/db.ts';
import {
	COMPANIONS as ATHENS_COMPANIONS,
	seedAthensSchedule
} from '../packages/server/src/seeds/seed-athens.ts';

interface Row {
	id: string;
	name: string;
}

function pickTrip(): string {
	const row = db
		.prepare(
			`SELECT t.id, t.name FROM trips t
			  JOIN memberships m ON m.trip_id = t.id
			  GROUP BY t.id HAVING count(m.user_id) >= 4
			  ORDER BY t.created_at DESC LIMIT 1`
		)
		.get() as Row | undefined;
	if (!row) throw new Error('No trip with at least 4 members. Pass a trip id.');
	return row.id;
}

const tripId = process.argv[2] ?? pickTrip();

const trip = db.prepare(`SELECT id, name FROM trips WHERE id = ?`).get(tripId) as Row | undefined;
if (!trip) throw new Error(`No trip ${tripId}`);

const city = db
	.prepare(`SELECT id, name FROM cities WHERE trip_id = ? ORDER BY sort LIMIT 1`)
	.get(tripId) as Row | undefined;
if (!city)
	throw new Error(`Trip "${trip.name}" has no cities; the sample needs one to hang events on.`);

const members = db
	.prepare(
		`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
		  WHERE m.trip_id = ? ORDER BY m.role = 'organizer' DESC, u.name`
	)
	.all(tripId) as Row[];

const organizerId = (
	db.prepare(`SELECT organizer_id AS id FROM trips WHERE id = ?`).get(tripId) as { id: string }
).id;

// Slot 0 is the organizer; slots 1..19 are the companions, by name where the
// trip has someone of that name and by whoever is spare where it does not.
const byName = new Map(members.map((m) => [m.name, m.id]));
const roster: string[] = [organizerId];
const taken = new Set([organizerId]);
for (const name of ATHENS_COMPANIONS) {
	const id = byName.get(name);
	if (id && !taken.has(id)) {
		taken.add(id);
		roster.push(id);
	} else {
		roster.push('');
	}
}
const spare = members.filter((m) => !taken.has(m.id)).map((m) => m.id);
// A trip smaller than the sample wraps, so a four-person trip still shows
// splits rather than events nobody is on.
for (let i = 1; i < roster.length; i++) {
	if (!roster[i]) roster[i] = spare.shift() ?? members[i % members.length].id;
}

const count = seedAthensSchedule(db, tripId, city.id, roster);
console.log(
	`Seeded ${count} events into "${trip.name}" (${city.name}), ${members.length} members.`
);
