import { useCallback, useEffect, useMemo, useState } from 'react';
import { copy } from '@trippy/copy';
import { suggestStart } from '@trippy/core/plan';
import { useApi } from '../../hooks/useApi';
import { useLiveSection } from '../../hooks/useTripEvents';
import { applyDraft, replanLegs } from './replan';
import { DRAFT_ID } from './shared';
import type { BoardDay, EventDraft, EventRow, LegRow, ScheduleData, ViewMode } from './types';

export function useScheduleDay(tripId: string, paused = false) {
	const [day, setDay] = useState<string | null>(null);
	const [view, setView] = useState<ViewMode>('day');
	const [viewAs, setViewAs] = useState('');
	const [preview, setPreview] = useState<EventDraft | null>(null);
	const [reloadDue, setReloadDue] = useState(false);
	const qs = new URLSearchParams({ view });
	if (day) qs.set('day', day);
	const apiState = useApi<ScheduleData>(`/trips/${tripId}/schedule?${qs}`);
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
	const effectiveDay = day ?? data?.day ?? null;
	const members = useMemo(() => data?.members ?? [], [data?.members]);
	const memberIds = useMemo(() => members.map((m) => m.id), [members]);

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

	const planned: BoardDay[] = useMemo(() => {
		const known = new Map(
			(data?.board ?? []).flatMap((entry) => entry.legs.map((l) => [l.key, l] as const))
		);
		return (data?.board ?? []).map((entry) => {
			const { events, stays } = applyDraft(entry, preview);
			return {
				...entry,
				events,
				stays,
				legs: preview ? replanLegs(entry, preview, memberIds, known) : entry.legs
			};
		});
	}, [data?.board, memberIds, preview]);

	const board: BoardDay[] = useMemo(() => {
		const showEvent = (e: EventRow) =>
			e.people.length === 0 || e.people.some((p) => selected.has(p));
		const showLeg = (l: LegRow) => l.people.some((p) => selected.has(p));
		return planned.map((entry) => ({
			...entry,
			events: entry.events.filter(showEvent),
			stays: entry.stays.filter(showEvent),
			legs: entry.legs.filter(showLeg)
		}));
	}, [planned, selected]);

	const anchor = useMemo(
		() => (data ? (board.find((entry) => entry.day === data.day) ?? board[0] ?? null) : null),
		[board, data]
	);

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

	const stepTo = useCallback((next: string | null) => {
		if (next) setDay(next);
	}, []);

	const suggestedStart = useCallback(
		(on: string) => suggestStart(board.find((entry) => entry.day === on)?.events ?? []),
		[board]
	);

	const legsTo = useCallback(
		(eventId: string) =>
			planned.flatMap((entry) => entry.legs.filter((leg) => leg.toEventId === eventId)),
		[planned]
	);

	return {
		...apiState,
		data,
		day: effectiveDay,
		setDay,
		view,
		setView,
		viewAs,
		setViewAs,
		readAs,
		visibleMemberIds,
		board,
		planned,
		anchor,
		eventById,
		locked: false,
		viewAsOptions,
		peopleLabel,
		setPreview,
		suggestedStart,
		legsTo,
		draftLegs: legsTo(DRAFT_ID),
		stepPrev: () => stepTo(data?.prevDay ?? null),
		stepNext: () => stepTo(data?.nextDay ?? null)
	};
}
