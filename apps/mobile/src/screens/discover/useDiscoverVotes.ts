import { useCallback, useEffect, useRef, useState } from 'react';
import { copy } from '@trippy/copy';
import type { Poi, Stay } from '../../lib/api-types';
import { api, ApiError } from '../../lib/api';

export function useDiscoverVotes({
	base,
	data,
	reload,
	onError
}: {
	base: string;
	data: unknown;
	reload: () => void;
	onError: (message: string) => void;
}) {
	const [places, setPlaces] = useState<Record<string, boolean>>({});
	const [stays, setStays] = useState<Record<string, string | null>>({});
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const busyRef = useRef(new Set<string>());
	const settled = useRef(new Set<string>());

	useEffect(() => {
		if (settled.current.size === 0) return;
		const done = [...settled.current];
		settled.current.clear();
		setPlaces((prev) => drop(prev, done, 'poi:'));
		setStays((prev) => drop(prev, done, 'city:'));
	}, [data]);

	const track = useCallback(
		async (key: string, path: string, fallback: string, undo: () => void) => {
			busyRef.current.add(key);
			setBusy(new Set(busyRef.current));
			try {
				await api(path, { method: 'POST' });
				settled.current.add(key);
				reload();
			} catch (err) {
				undo();
				onError(err instanceof ApiError ? err.message : fallback);
			} finally {
				busyRef.current.delete(key);
				setBusy(new Set(busyRef.current));
			}
		},
		[onError, reload]
	);

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
		void track(key, `${base}/pois/${p.id}/vote`, copy.discover.errors.votePlace, () =>
			setPlaces((m) => omit(m, p.id))
		);
	}

	function toggleStay(cityId: string, s: Stay) {
		const key = `city:${cityId}`;
		if (busyRef.current.has(key)) return;
		const shown = stay(cityId, s);
		setStays((m) => ({ ...m, [cityId]: shown.you_voted ? null : s.id }));
		void track(key, `${base}/stays/${s.id}/vote`, copy.discover.errors.voteStay, () =>
			setStays((m) => omit(m, cityId))
		);
	}

	return { place, stay, togglePlace, toggleStay };
}

function drop<V>(prev: Record<string, V>, done: string[], prefix: string): Record<string, V> {
	const next = { ...prev };
	for (const key of done) if (key.startsWith(prefix)) delete next[key.slice(prefix.length)];
	return next;
}

function omit<V>(prev: Record<string, V>, key: string): Record<string, V> {
	const next = { ...prev };
	delete next[key];
	return next;
}
