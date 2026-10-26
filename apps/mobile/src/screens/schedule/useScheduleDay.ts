import { useCallback, useEffect, useMemo, useState } from 'react';
import { copy } from '@trippy/copy';
import { suggestStart } from '@trippy/core/plan';
import { useApi } from '../../hooks/useApi';
import { rememberScheduleDay, scheduleOpeningDay } from '../../lib/scheduleDay';
import { useLiveSection } from '../../hooks/useTripEvents';
import { applyDraft, replanLegs } from './replan';
import type { JourneyEdits } from './journeys';
import { DRAFT_ID, zoneLookup } from './shared';
import type { BoardDay, EventDraft, EventRow, LegRow, ScheduleData, ViewMode } from './types';

export function useScheduleDay(
	tripId: string,
	paused = false,
	trip?: { id: string; start_date: string | null; end_date: string | null } | null
) {
	const [day, setDay] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const [view, setView] = useState<ViewMode>('day');
	const [viewAs, setViewAs] = useState('');
	const [preview, setPreview] = useState<EventDraft | null>(null);
	// The open sheet's unsaved journey edits, keyed by leg key, drawn with its draft.
	const [journeyPreview, setJourneyPreview] = useState<JourneyEdits | null>(null);
	const [reloadDue, setReloadDue] = useState(false);
	// A step pressed before the day it steps from has loaded its own neighbours:
	// -1 or 1, carried out when that payload lands.
	const [queued, setQueued] = useState(0);
	// Every request names the day view. The server sends the same three days for
	// either view, and leaving the view out of the url means switching between
	// Day and Agenda is not a reload. The agenda filter (`readAs`) is applied
	// here, not by the server.
	const qs = new URLSearchParams({ view: 'day' });
	if (day) qs.set('day', day);
	useEffect(() => {
		setReady(false);
		setDay(null);
	}, [tripId]);
	useEffect(() => {
		if (ready || trip === undefined) return;
		let alive = true;
		const choose = trip?.id === tripId ? scheduleOpeningDay(trip) : Promise.resolve(null);
		void choose.then((next) => {
			if (!alive) return;
			setDay(next);
			setReady(true);
		});
		return () => {
			alive = false;
		};
	}, [ready, trip, tripId]);
	const apiState = useApi<ScheduleData>(ready ? `/trips/${tripId}/schedule?${qs}` : null);
	const reload = useCallback(() => {
		if (paused) setReloadDue(true);
		else apiState.reload();
	}, [apiState.reload, paused]);
	useLiveSection(['schedule', 'lodging', 'members', 'trip'], reload);
	useEffect(() => {
		if (paused || !reloadDue) return;
		setReloadDue(false);
		apiState.reload();
	}, [apiState.reload, paused, reloadDue]);

	const data = apiState.data;
	/*
	 * The day on screen: the one asked for as soon as the payload holds it, else
	 * the payload's own day until the asked-for one lands (a jump from the date
	 * picker to a day that was not beside the last one). A step therefore draws
	 * the next day in the same frame as the tap, and the payload that follows
	 * only fills in the day after it.
	 */
	const shownDay = useMemo(() => {
		if (!data) return null;
		return day && data.board.some((entry) => entry.day === day) ? day : data.day;
	}, [data, day]);
	useEffect(() => {
		if (shownDay) void rememberScheduleDay(tripId, shownDay);
	}, [shownDay, tripId]);
	/*
	 * The days either side of the shown one. `undefined` is not known yet: the
	 * shown day was held as a neighbour, and its own far neighbour comes with its
	 * payload. The arrow stays enabled, and a press is carried out when it lands.
	 */
	const around = useMemo((): {
		prev: string | null | undefined;
		next: string | null | undefined;
	} => {
		if (!data || shownDay === data.day) {
			return { prev: data?.prevDay ?? null, next: data?.nextDay ?? null };
		}
		if (shownDay === data.nextDay) return { prev: data.day, next: undefined };
		if (shownDay === data.prevDay) return { prev: undefined, next: data.day };
		return { prev: undefined, next: undefined };
	}, [data, shownDay]);
	useEffect(() => {
		if (!queued || !data || data.day !== day) return;
		setQueued(0);
		const to = queued < 0 ? data.prevDay : data.nextDay;
		if (to) setDay(to);
	}, [data, day, queued]);
	const members = useMemo(() => data?.members ?? [], [data?.members]);
	const memberIds = useMemo(() => members.map((m) => m.id), [members]);
	const zoneOf = useMemo(() => zoneLookup(data?.cities ?? []), [data?.cities]);

	const readAs = useMemo(() => {
		if (view !== 'agenda') return viewAs;
		if (viewAs) return viewAs;
		const roster = new Set(memberIds);
		return data?.me && roster.has(data.me) ? data.me : (memberIds[0] ?? '');
	}, [data?.me, memberIds, view, viewAs]);

	const selected = useMemo(() => {
		const roster = new Set(memberIds);
		return new Set(readAs && roster.has(readAs) ? [readAs] : memberIds);
	}, [readAs, memberIds]);
	const visibleMemberIds = useMemo(() => [...selected], [selected]);

	/*
	 * A save from the sheet, held until its own payload lands.
	 *
	 * The sheet clears its draft as it closes, and the reload is a round trip
	 * behind it. Dropping the draft at once drew the old saved day in between:
	 * a block saved at 4:40 went back to 9:30 and the board's window closed to
	 * its floor, then the payload reopened it and the floor's offset pushed
	 * the block the reader had just placed off the top. The draft is drawn
	 * instead until the payload that follows the save arrives (or the reload
	 * ends without one), and that payload is reported as the reader's own
	 * write (`ownWrite`), so the board lets its floor drop without moving the
	 * scroll, as the web board does for `ownWrite`.
	 */
	const [hold, setHold] = useState<{
		draft: EventDraft | null;
		journeys: JourneyEdits | null;
		from: ScheduleData;
		sent: boolean;
	} | null>(null);
	const heldNow = hold && data === hold.from ? hold : null;
	const draft = preview ?? heldNow?.draft ?? null;
	const journeys = preview ? journeyPreview : (heldNow?.journeys ?? null);
	const ownWrite = hold !== null && data !== hold.from;
	useEffect(() => {
		if (!hold) return;
		if (data !== hold.from) setHold(null);
		else if (apiState.loading && !hold.sent) setHold({ ...hold, sent: true });
		else if (!apiState.loading && hold.sent) setHold(null);
	}, [apiState.loading, data, hold]);
	const afterSave = useCallback(() => {
		if (data) setHold({ draft: preview, journeys: journeyPreview, from: data, sent: false });
		setPreview(null);
		setJourneyPreview(null);
		reload();
	}, [data, journeyPreview, preview, reload]);

	/*
	 * The board as the open sheet would leave it. Two plans: `planned` carries
	 * the draft and the journey edits, and is what every reader of the day draws
	 * (the bars, their place, `tight`, the view-as marks, the map). `drafted`
	 * carries the draft alone, and is what the sheet's journey fields are read
	 * against: an edit is compared with the journey as it would be without it,
	 * both to show the right estimate per mode and to know whether to save it.
	 */
	const { planned, drafted } = useMemo(() => {
		const known = new Map(
			(data?.board ?? []).flatMap((entry) => entry.legs.map((l) => [l.key, l] as const))
		);
		const edited = journeys && Object.keys(journeys).length ? journeys : null;
		const both = (data?.board ?? []).map((entry) => {
			const { events, stays } = applyDraft(entry, draft, zoneOf);
			const base =
				draft || edited ? replanLegs(entry, draft, memberIds, known, zoneOf) : entry.legs;
			const legs = edited ? replanLegs(entry, draft, memberIds, known, zoneOf, edited) : base;
			return { live: { ...entry, events, stays, legs }, base };
		});
		return {
			planned: both.map((b): BoardDay => b.live),
			drafted: both.map((b) => b.base)
		};
	}, [data?.board, memberIds, draft, journeys, zoneOf]);

	const visible = useCallback(
		(entry: BoardDay): BoardDay => {
			const showEvent = (e: EventRow) =>
				e.people.length === 0 || e.people.some((p) => selected.has(p));
			const showLeg = (l: LegRow) => l.people.some((p) => selected.has(p));
			return {
				...entry,
				events: entry.events.filter(showEvent),
				stays: entry.stays.filter(showEvent),
				legs: entry.legs.filter(showLeg)
			};
		},
		[selected]
	);

	const board: BoardDay[] = useMemo(() => planned.map(visible), [planned, visible]);

	const anchor = useMemo(
		() => (data ? (board.find((entry) => entry.day === shownDay) ?? board[0] ?? null) : null),
		[board, data, shownDay]
	);

	/*
	 * The shown day as it is saved: the payload's own entry, under the same
	 * view-as filter, but without the open sheet's unsaved draft. The day
	 * board's floor is read from this, so a time picked in a sheet and then
	 * cancelled does not open the board earlier for the rest of the visit.
	 */
	const savedAnchor = useMemo(() => {
		const entries = data?.board ?? [];
		const entry = entries.find((e) => e.day === shownDay) ?? entries[0];
		return entry ? visible(entry) : null;
	}, [data?.board, shownDay, visible]);

	const eventById = useMemo(() => {
		const out = new Map<string, EventRow>();
		for (const entry of planned) {
			for (const ev of entry.events) out.set(ev.id, ev);
			for (const stay of entry.stays) out.set(stay.id, stay);
			for (const stay of entry.incoming) out.set(stay.id, stay);
		}
		return out;
	}, [planned]);

	const tightPeople = useMemo(() => {
		const out = new Set<string>();
		for (const entry of planned) {
			for (const leg of entry.legs) {
				if (leg.tight) for (const person of leg.people) out.add(person);
			}
		}
		return out;
	}, [planned]);

	const viewAsOptions = useMemo(
		() => [
			...(view === 'agenda'
				? []
				: [
						{
							key: '',
							label: copy.viewAs.everyone,
							warn: tightPeople.size > 0
						}
					]),
			...members.map((m) => ({
				key: m.id,
				label: m.name + (m.id === data?.me ? copy.preparation.youSuffix : ''),
				warn: tightPeople.has(m.id)
			}))
		],
		[members, data?.me, tightPeople, view]
	);

	const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
	const peopleLabel = useCallback(
		(ids: string[]) => {
			if (ids.length === 0 || ids.length === members.length) return copy.common.everyone;
			return ids.map((id) => (memberName.get(id) ?? '?').split(' ')[0]).join(', ');
		},
		[memberName, members.length]
	);

	const step = (delta: -1 | 1) => {
		const to = delta < 0 ? around.prev : around.next;
		if (to === undefined) setQueued(delta);
		else if (to) {
			setQueued(0);
			setDay(to);
		}
	};
	const pickDay = useCallback((next: string) => {
		setQueued(0);
		setDay(next);
	}, []);

	const suggestedStart = useCallback(
		// The day, so a block carried in from last night is read by where it ends
		// this morning rather than by its stored end time.
		(on: string) => suggestStart(board.find((entry) => entry.day === on)?.events ?? [], on, zoneOf),
		[board, zoneOf]
	);

	// The journeys into an event without the sheet's journey edits, which is
	// what the sheet reads its fields against (see `drafted`), and with them.
	const legsTo = useCallback(
		(eventId: string) => drafted.flatMap((legs) => legs.filter((leg) => leg.toEventId === eventId)),
		[drafted]
	);
	const liveLegsTo = useCallback(
		(eventId: string) =>
			planned.flatMap((entry) => entry.legs.filter((leg) => leg.toEventId === eventId)),
		[planned]
	);

	return {
		...apiState,
		loading: apiState.loading || !ready,
		data,
		/** The day on screen, which leads the payload's `day` on a step. */
		day: shownDay,
		setDay: pickDay,
		/** The shown day's neighbours; null at an end, undefined while unknown. */
		prevDay: around.prev,
		nextDay: around.next,
		view,
		setView,
		viewAs,
		setViewAs,
		readAs,
		visibleMemberIds,
		board,
		planned,
		anchor,
		savedAnchor,
		/** True for the payload that follows the reader's own save from the sheet. */
		ownWrite,
		/** The sheet saved: hold its draft on the board until the reload lands. */
		afterSave,
		eventById,
		locked: false,
		zoneOf,
		viewAsOptions,
		peopleLabel,
		setPreview,
		setJourneyPreview,
		suggestedStart,
		legsTo,
		liveLegsTo,
		draftLegs: legsTo(DRAFT_ID),
		draftLiveLegs: liveLegsTo(DRAFT_ID),
		stepPrev: () => step(-1),
		stepNext: () => step(1)
	};
}
