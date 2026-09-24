import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import type { Poi, Stay } from '../../lib/api-types';
import { copy } from '../../copy';

const cd = copy.discover;

/**
 * Votes on Discover: optimistic, and one request per card at a time.
 *
 * A vote is a toggle on the server, so a double tap sent two toggles and the
 * card landed back where it started, looking as though the tap had not
 * registered. The pill is now held while its request is out (a ref as well as
 * state, so two taps inside one frame cannot both get through before the
 * re-render disables it), and it shows the new state at once rather than after
 * the round trip and the refetch behind it.
 *
 * What is held is the *intended* state, never a flip. The count shown is the
 * server's count with the viewer's own vote swapped for the intended one, so
 * it is right whether or not the refetch has already landed: a flip applied on
 * top of a response that already contains the vote would count it twice. The
 * intent is dropped on a failure (the toast says why) and on the first
 * response after a success, by which point the server's row says the same.
 *
 * Stays are one vote per city on the server, so a stay's intent is "which
 * stay in this city has my vote", and voting for one takes it off another.
 */
export function useVotes({
	base,
	data,
	reload,
	onError
}: {
	base: string;
	/** The loaded payload. A new one is what ends a settled intent. */
	data: unknown;
	reload: () => void;
	onError: (message: string) => void;
}) {
	/** Place id to whether the viewer means to have voted for it. */
	const [places, setPlaces] = useState<Record<string, boolean>>({});
	/** City id to the stay the viewer means to have their vote on, or null. */
	const [stays, setStays] = useState<Record<string, string | null>>({});
	/** Requests in flight: `poi:<id>`, and `city:<id>` for a city's stays. */
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const busyRef = useRef(new Set<string>());
	/** Intents whose write succeeded, waiting for the response that confirms them. */
	const settled = useRef(new Set<string>());

	const votePlace = useMutation<[string]>(
		(id) => api(`${base}/pois/${id}/vote`, { method: 'POST' }),
		{ fallback: cd.errors.votePlace, onSuccess: reload, onError }
	);
	const voteStay = useMutation<[string]>(
		(id) => api(`${base}/stays/${id}/vote`, { method: 'POST' }),
		{ fallback: cd.errors.voteStay, onSuccess: reload, onError }
	);

	useEffect(() => {
		if (settled.current.size === 0) return;
		const done = [...settled.current];
		settled.current.clear();
		const drop = <V>(prev: Record<string, V>, prefix: string) => {
			const next = { ...prev };
			for (const k of done) if (k.startsWith(prefix)) delete next[k.slice(prefix.length)];
			return next;
		};
		setPlaces((p) => drop(p, 'poi:'));
		setStays((s) => drop(s, 'city:'));
	}, [data]);

	const track = useCallback(
		async (key: string, write: () => Promise<boolean>, undo: () => void) => {
			busyRef.current.add(key);
			setBusy(new Set(busyRef.current));
			const ok = await write();
			busyRef.current.delete(key);
			setBusy(new Set(busyRef.current));
			if (ok) settled.current.add(key);
			else undo();
		},
		[]
	);

	/** A place as it should be drawn, with the viewer's pending vote applied. */
	const place = (p: Poi): Poi & { voteBusy: boolean } => {
		const want = places[p.id];
		const voteBusy = busy.has(`poi:${p.id}`);
		if (want === undefined) return { ...p, voteBusy };
		return {
			...p,
			you_voted: want ? 1 : 0,
			votes: p.votes - (p.you_voted ? 1 : 0) + (want ? 1 : 0),
			voteBusy
		};
	};

	/** A stay as it should be drawn, given which stay in its city holds the vote. */
	const stay = (cityId: string, s: Stay): Stay & { voteBusy: boolean } => {
		const voteBusy = busy.has(`city:${cityId}`);
		if (!(cityId in stays)) return { ...s, voteBusy };
		const mine = stays[cityId] === s.id;
		return {
			...s,
			you_voted: mine ? 1 : 0,
			votes: s.votes - (s.you_voted ? 1 : 0) + (mine ? 1 : 0),
			voteBusy
		};
	};

	function togglePlace(p: Poi) {
		const key = `poi:${p.id}`;
		if (busyRef.current.has(key)) return;
		const shown = place(p);
		setPlaces((m) => ({ ...m, [p.id]: !shown.you_voted }));
		void track(
			key,
			() => votePlace.run(p.id),
			() =>
				setPlaces((m) => {
					const next = { ...m };
					delete next[p.id];
					return next;
				})
		);
	}

	function toggleStay(cityId: string, s: Stay) {
		const key = `city:${cityId}`;
		if (busyRef.current.has(key)) return;
		const shown = stay(cityId, s);
		setStays((m) => ({ ...m, [cityId]: shown.you_voted ? null : s.id }));
		void track(
			key,
			() => voteStay.run(s.id),
			() =>
				setStays((m) => {
					const next = { ...m };
					delete next[cityId];
					return next;
				})
		);
	}

	return { place, stay, togglePlace, toggleStay };
}
