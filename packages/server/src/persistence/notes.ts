import { db } from '../db';
import { publish } from '../events';
import { isMember } from './membership';
import { isNotesBodyLength, mergeNotes, type TripNotes } from '@trippy/core/notes';

/**
 * The trip's one shared notepad (Preparation > Notes; DESIGN.md 5.0.4).
 *
 * Every member edits the same text, so a save is a compare-and-set on
 * `trip_notes.version` rather than a plain overwrite: whoever saves against a
 * version that has moved on is refused with the current notes, and their client
 * merges (`mergeNotes` in `@trippy/core/notes`) and saves again, or, if it sent
 * the `base` its text came from, the server does that merge itself. A plain
 * overwrite would let the second of two people typing at once silently delete
 * the first one's paragraph.
 */

export type { TripNotes };

/** The notepad of a trip that has never saved one. */
const EMPTY: TripNotes = { body: '', version: 0, updatedAt: null, updatedBy: null };

/**
 * The notepad as it is now. A trip with no row has empty notes at version 0,
 * which is also what the first save has to name.
 *
 * `updatedBy` is null when nobody has saved, and when the account that saved
 * last has since been deleted (`updated_by` is ON DELETE SET NULL).
 */
export function getNotes(tripId: string): TripNotes {
	const row = db
		.prepare(
			`SELECT n.body AS body, n.version AS version, n.updated_at AS updated_at,
			        u.id AS user_id, u.name AS user_name
			   FROM trip_notes n
			   LEFT JOIN users u ON u.id = n.updated_by
			  WHERE n.trip_id = ?`
		)
		.get(tripId) as
		| {
				body: string;
				version: number;
				updated_at: number | null;
				user_id: string | null;
				user_name: string | null;
		  }
		| undefined;
	if (!row) return { ...EMPTY };
	return {
		body: row.body,
		version: row.version,
		updatedAt: row.updated_at,
		updatedBy: row.user_id ? { id: row.user_id, name: row.user_name ?? '' } : null
	};
}

export type SaveNotesResult =
	/**
	 * Saved. `notes` is the new state. `merged` is true when the version was
	 * stale and the server merged the body into what was stored (see `base`).
	 */
	| { ok: true; notes: TripNotes; merged: boolean }
	/** Somebody saved first and there was no `base` to merge with. `notes` is what is stored now. */
	| { ok: false; reason: 'conflict'; notes: TripNotes }
	/** The server-side merge came out over `MAX_NOTES_BODY`. Nothing written; `notes` is what is stored. */
	| { ok: false; reason: 'too-long'; notes: TripNotes }
	/**
	 * Not a member, a body, base or priorBase over `MAX_NOTES_BODY`, a priorBase
	 * without a base, or a version that is not a count.
	 */
	| { ok: false; reason: 'invalid' };

/**
 * How many times a merge is retried when another save lands between reading
 * the stored notes and writing the merge. In one Node process the read and the
 * write cannot be interleaved at all; the loop is for a second process on the
 * same file, and three is far past what a household's notepad will ever see.
 */
const MERGE_ATTEMPTS = 3;

/**
 * Write `body` if the stored version is still `version`.
 *
 * Atomic without a transaction: each branch is one statement whose WHERE is
 * the version check. The UPDATE only matches the row at the expected version;
 * the INSERT only runs for version 0 and does nothing if a row appeared in the
 * meantime. Either way the check and the write are the same statement, so two
 * saves against the same version cannot both land, even from two processes.
 */
function compareAndSet(tripId: string, actorId: string, body: string, version: number): boolean {
	const now = Date.now();
	const updated = Number(
		db
			.prepare(
				`UPDATE trip_notes
				    SET body = ?, version = version + 1, updated_by = ?, updated_at = ?
				  WHERE trip_id = ? AND version = ?`
			)
			.run(body, actorId, now, tripId, version).changes
	);
	if (updated > 0) return true;
	if (version !== 0) return false;
	const inserted = Number(
		db
			.prepare(
				`INSERT INTO trip_notes (trip_id, body, version, updated_by, updated_at)
				 VALUES (?, ?, 1, ?, ?)
				 ON CONFLICT (trip_id) DO NOTHING`
			)
			.run(tripId, body, actorId, now).changes
	);
	return inserted > 0;
}

/**
 * Save the notepad if nobody else has since `expectedVersion`.
 *
 * `base`, when given, is the stored text the client's `body` was derived from.
 * A save whose `base` is no longer what is stored is then not refused: the
 * server merges, `mergeNotes(base, body, stored)`, and saves that at the stored
 * version, retrying if another save slips in between. That holds whether the
 * version is stale or happens to match (an optimistic version can match a
 * save it never saw). This is for the saves a client cannot retry itself:
 * one sent while the page unloads, or by a notepad that has already unmounted,
 * never reads its 409, so the text in it used to be lost. Without `base` a
 * stale version is the plain 409 it always was. A merge that comes out over
 * the ceiling writes nothing.
 *
 * `priorBase`, when given (only alongside `base`), is the base the client's
 * in-flight save was itself sent from. A speculative save made on hide or
 * background names that in-flight save's text as `base` before knowing whether
 * it landed. If it never did, the store still holds `priorBase`, and merging
 * from `base` would read the in-flight save's lines as something the store had
 * deleted. So with `priorBase` a store holding `base` or `priorBase` takes
 * `body` as written (it already contains everything since `priorBase`), and
 * anything else is merged from the older ancestor, `mergeNotes(priorBase,
 * body, stored)`: if the in-flight save landed and someone saved after it,
 * its lines are on both sides and collapse into one copy.
 *
 * Saving the same text again is a real write: it bumps the version and the
 * "edited by" line, and publishes. The client only saves when something was
 * typed, so an identical body means somebody typed and undid it, and telling
 * the others that they did is harmless.
 *
 * The route checks the body, bases and version first so it can say what is
 * wrong; they are checked again here so no other caller can store what the
 * route would refuse.
 */
export function saveNotes(
	tripId: string,
	actorId: string,
	body: string,
	expectedVersion: number,
	base?: string,
	priorBase?: string
): SaveNotesResult {
	if (typeof body !== 'string' || !isNotesBodyLength(body)) return { ok: false, reason: 'invalid' };
	if (base !== undefined && (typeof base !== 'string' || !isNotesBodyLength(base))) {
		return { ok: false, reason: 'invalid' };
	}
	if (
		priorBase !== undefined &&
		(base === undefined || typeof priorBase !== 'string' || !isNotesBodyLength(priorBase))
	) {
		return { ok: false, reason: 'invalid' };
	}
	if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
		return { ok: false, reason: 'invalid' };
	}
	if (!isMember(tripId, actorId)) return { ok: false, reason: 'invalid' };

	if (base === undefined) {
		if (compareAndSet(tripId, actorId, body, expectedVersion)) {
			publish(tripId, 'notes');
			return { ok: true, notes: getNotes(tripId), merged: false };
		}
		return { ok: false, reason: 'conflict', notes: getNotes(tripId) };
	}

	// With a base, the stored text decides, not the version alone. A client
	// saving from the background or on unload can send an optimistic version
	// (its in-flight save's plus one); if somebody else's save took that version
	// first, the version matches and a plain write would replace their text. So
	// without `priorBase` only "stored body is still `base` at the expected
	// version" is a plain write, and with it "stored body is `base` or
	// `priorBase`" is, at whatever version that body is stored at. Every write
	// bumps the version, so the compare-and-set at the version just read also
	// proves the body compared is still the one stored.
	const ancestor = priorBase ?? base;
	for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
		const current = getNotes(tripId);
		const plain =
			priorBase === undefined
				? current.version === expectedVersion && current.body === base
				: current.body === base || current.body === priorBase;
		if (plain) {
			if (compareAndSet(tripId, actorId, body, current.version)) {
				publish(tripId, 'notes');
				return { ok: true, notes: getNotes(tripId), merged: false };
			}
			continue;
		}
		const merged = mergeNotes(ancestor, body, current.body);
		if (!isNotesBodyLength(merged)) return { ok: false, reason: 'too-long', notes: current };
		if (compareAndSet(tripId, actorId, merged, current.version)) {
			publish(tripId, 'notes');
			return { ok: true, notes: getNotes(tripId), merged: true };
		}
	}
	return { ok: false, reason: 'conflict', notes: getNotes(tripId) };
}
