<script lang="ts">
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import TripMap from '$lib/components/TripMap.svelte';
	import GoogleMap from '$lib/components/GoogleMap.svelte';
	import Select from '$lib/components/Select.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { localTime, zoneAbbr, localDayMinutes } from '@trippy/core/tz';
	import { layoutDay, personBands } from '@trippy/core/layout';
	import { focusOnMount } from '$lib/focus';

	let { data } = $props();

	// Members for assignment + "view as". Map id -> name for chips.
	let memberOptions = $derived(data.members.map((m) => ({ value: m.id, label: m.name })));
	let memberName = $derived(new Map(data.members.map((m) => [m.id, m.name])));
	/** First name only, since arrow labels and chips get cramped fast. */
	function shortName(id: string): string {
		return (memberName.get(id) ?? '?').split(' ')[0];
	}

	// "View as" filter: '' = everyone, otherwise a member id. Only items that
	// person is assigned to (plus unassigned shared items) are shown.
	let viewAs = $state('');
	const viewAsOptions = $derived([
		{ value: '', label: 'Everyone' },
		...data.members.map((m) => ({ value: m.id, label: m.name }))
	]);
	function itemVisible(item: { assignees: string[] }): boolean {
		if (!viewAs) return true;
		// Unassigned items are shared/whole-group, so always shown.
		return item.assignees.length === 0 || item.assignees.includes(viewAs);
	}
	// A track (party lane) is shown in "view as X" only when X belongs to that
	// party on the day. The Everyone party contains all members, so single-group
	// trips are unaffected.
	function trackVisible(track: { partyMembers: string[] }): boolean {
		if (!viewAs) return true;
		return track.partyMembers.includes(viewAs);
	}

	const dayStart = 8 * 60;
	const dayEnd = 18 * 60;
	const pxPerMin = 1.2;
	const headPx = 34;
	const hours = Array.from({ length: (dayEnd - dayStart) / 60 + 1 }, (_, i) => 8 + i);

	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	function dayLabel(iso: string): string {
		const [y, m, d] = iso.split('-').map(Number);
		const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
		return `${weekdays[wd]}, ${months[m - 1]} ${d}`;
	}
	function hhmm(min: number): string {
		const h = Math.floor(min / 60);
		const m = min % 60;
		return `${h}:${String(m).padStart(2, '0')}`;
	}

	const itemUrl = $derived(`/trips/${$page.params.tripId}/calendar/item`);

	// Live drag state for a single item.
	let drag = $state<{ id: string; pointerStartY: number; origStart: number; liveStart: number } | null>(
		null
	);

	// Live resize state (dragging the bottom edge changes the end time).
	let resize = $state<
		{ id: string; pointerStartY: number; startMin: number; origEnd: number; liveEnd: number } | null
	>(null);

	// Event detail popup: opened by clicking a block. Holds a working copy that is
	// only persisted on Save, plus read-only context (track, travel to next).
	let detail = $state<{
		id: string;
		trackId: string;
		trackName: string;
		trackColor: string;
		title: string;
		type: string;
		start: string;
		duration: string;
		travelBefore: string;
		assignees: string[];
		booking: string | null;
		travelMode: string | null;
		travelMins: number | null;
		poiId: string | null;
		saving: boolean;
	} | null>(null);

	// Set while a pointer drag/resize actually moves, so the click that follows a
	// drag doesn't also open the detail popup.
	let didDrag = false;

	const editTravelOptions = [
		{ value: '0', label: 'No travel' },
		{ value: '10', label: '+10m' },
		{ value: '15', label: '+15m' },
		{ value: '30', label: '+30m' },
		{ value: '45', label: '+45m' },
		{ value: '60', label: '+1h' }
	];

	function startFor(item: { id: string; start_min: number }): number {
		return drag && drag.id === item.id ? drag.liveStart : item.start_min;
	}

	function endFor(item: { id: string; start_min: number; end_min: number }): number {
		if (resize && resize.id === item.id) return resize.liveEnd;
		return startFor(item) + (item.end_min - item.start_min);
	}

	function onPointerDown(e: PointerEvent, item: { id: string; start_min: number }) {
		// let button clicks and inline-edit inputs through
		if ((e.target as HTMLElement).closest('.tag, .bdel, .bresize')) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag = false;
		drag = { id: item.id, pointerStartY: e.clientY, origStart: item.start_min, liveStart: item.start_min };
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag) return;
		const deltaMin = (e.clientY - drag.pointerStartY) / pxPerMin;
		if (Math.abs(e.clientY - drag.pointerStartY) > 3) didDrag = true;
		// Snap the live position to 5-minute steps so the label never shows decimals.
		drag.liveStart = Math.round((drag.origStart + deltaMin) / 5) * 5;
	}

	async function onPointerUp() {
		if (!drag) return;
		const snapped = Math.round(drag.liveStart / 5) * 5;
		const id = drag.id;
		const moved = snapped !== drag.origStart;
		drag = null;
		if (moved) {
			await fetch(itemUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ itemId: id, op: 'move', startMin: snapped })
			});
			await invalidateAll();
		}
	}

	function onResizeDown(e: PointerEvent, item: { id: string; start_min: number; end_min: number }) {
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag = false;
		resize = {
			id: item.id,
			pointerStartY: e.clientY,
			startMin: item.start_min,
			origEnd: item.end_min,
			liveEnd: item.end_min
		};
	}

	function onResizeMove(e: PointerEvent) {
		if (!resize) return;
		const deltaMin = (e.clientY - resize.pointerStartY) / pxPerMin;
		if (Math.abs(e.clientY - resize.pointerStartY) > 3) didDrag = true;
		resize.liveEnd = Math.max(resize.startMin + 15, Math.round((resize.origEnd + deltaMin) / 5) * 5);
	}

	async function onResizeUp() {
		if (!resize) return;
		const snapped = Math.round(resize.liveEnd / 5) * 5;
		const id = resize.id;
		const changed = snapped !== resize.origEnd;
		resize = null;
		if (changed) {
			await fetch(itemUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ itemId: id, op: 'resize', endMin: snapped })
			});
			await invalidateAll();
		}
	}

	function openDetail(
		item: {
			id: string;
			title: string;
			type: string;
			start_min: number;
			end_min: number;
			booking: string | null;
			travel_mode: string | null;
			travel_mins: number | null;
			travel_before_min: number | null;
			poi_id: string | null;
			assignees: string[];
		},
		track: { id: string; name: string; color: string }
	) {
		if (didDrag) return;
		detail = {
			id: item.id,
			trackId: track.id,
			trackName: track.name,
			trackColor: track.color,
			title: item.title,
			type: item.type,
			start: String(item.start_min),
			duration: String(item.end_min - item.start_min),
			travelBefore: String(item.travel_before_min ?? 0),
			assignees: [...item.assignees],
			booking: item.booking,
			travelMode: item.travel_mode,
			travelMins: item.travel_mins,
			poiId: item.poi_id,
			saving: false
		};
	}

	async function saveDetail() {
		if (!detail || detail.saving) return;
		detail.saving = true;
		const { id, title, type, travelBefore, assignees, start, duration } = detail;
		const startMin = Number(start);
		const endMin = startMin + Number(duration);
		await fetch(itemUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ itemId: id, op: 'edit', title, type, travelBefore })
		});
		await fetch(itemUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ itemId: id, op: 'move', startMin })
		});
		await fetch(itemUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ itemId: id, op: 'resize', endMin })
		});
		// Assignees are stored via a form action; persist them alongside the edit.
		const fd = new FormData();
		fd.set('itemId', id);
		fd.set('assignees', assignees.join(','));
		await fetch(`?/setAssignees`, { method: 'POST', body: fd });
		detail = null;
		await invalidateAll();
	}

	/** Cycle booked → tentative → unbooked from inside the popup, keeping it open. */
	async function cycleDetail() {
		if (!detail) return;
		const order = ['booked', 'tentative', 'unbooked'];
		const i = order.indexOf(detail.booking ?? 'unbooked');
		detail.booking = order[(i + 1) % order.length];
		await cycle(detail.id);
	}

	async function cycle(id: string) {
		await fetch(itemUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ itemId: id, op: 'cycle' })
		});
		await invalidateAll();
	}

	async function del(id: string) {
		await fetch(itemUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ itemId: id, op: 'delete' })
		});
		await invalidateAll();
	}

	// Tracks/items with the "view as" filter applied (drives board, map, legs).
	let filteredBoard = $derived(
		data.board.map((b) => ({
			...b,
			tracks: b.tracks
				.filter(trackVisible)
				.map((t) => ({ ...t, items: t.items.filter(itemVisible) }))
		}))
	);
	// Route list: items that have a travel leg to the next stop.
	let allTracks = $derived(filteredBoard.flatMap((b) => b.tracks));
	// Discovered places in the anchor day's city, shown as faded dots so it's easy to
	// see which candidates sit near the scheduled stops. Skip ones already scheduled.
	let poiPinTrack = $derived.by(() => {
		const cityId = anchorCityView?.id;
		if (!cityId) return null;
		const scheduled = new Set(
			allTracks.flatMap((t) => t.items.map((i) => i.poi_id).filter(Boolean))
		);
		const items = data.saved
			.filter((p) => p.city_id === cityId && p.lat != null && p.lng != null && !scheduled.has(p.id))
			.map((p) => ({ title: p.name, lat: p.lat, lng: p.lng }));
		return items.length ? { name: 'Places', color: '#9aa39c', items, line: false, dot: true } : null;
	});
	// Tracks handed to the map: scheduled routes plus the POI dots.
	let mapTracks = $derived(poiPinTrack ? [...allTracks, poiPinTrack] : allTracks);
	let legs = $derived(
		allTracks.flatMap((t) =>
			t.items
				.filter((i) => i.travel_mins != null)
				.map((i) => ({ title: i.title, mode: i.travel_mode, mins: i.travel_mins, tight: (i.travel_mins ?? 0) >= 25 }))
		)
	);

	// The anchor day's tracks drive the add/schedule forms (unfiltered: the track
	// picker should list every track regardless of the "view as" filter).
	let anchor = $derived(data.board.find((b) => b.day === data.day) ?? data.board[0] ?? null);
	let anchorTracks = $derived(anchor?.tracks ?? []);
	// Display uses the filtered copy so "view as" hides other people's items.
	let filteredAnchor = $derived(
		filteredBoard.find((b) => b.day === data.day) ?? filteredBoard[0] ?? null
	);

	/**
	 * Flatten a day's tracks into events with resolved attendees. Explicit
	 * assignees win; otherwise the event belongs to everyone on its track's crew.
	 * Layout and the swimlane both work off this, so "who is on this event" has a
	 * single answer.
	 */
	function eventsFor(entry: { tracks: typeof anchorTracks } | null) {
		if (!entry) return [];
		return entry.tracks.flatMap((t) =>
			t.items.map((i) => ({
				...i,
				trackId: t.id,
				trackName: t.name,
				trackColor: t.color,
				people: i.assignees.length ? i.assignees : t.partyMembers
			}))
		);
	}

	type DayEvent = ReturnType<typeof eventsFor>[number];

	function layoutFor(events: DayEvent[]) {
		return layoutDay(
			events.map((e) => ({ id: e.id, start: e.start_min, end: e.end_min, people: e.people }))
		);
	}

	let anchorEvents = $derived(eventsFor(filteredAnchor));
	let anchorLayout = $derived(layoutFor(anchorEvents));
	let eventById = $derived(new Map(anchorEvents.map((e) => [e.id, e])));

	/**
	 * Arrows worth drawing: hops where the travelling group differs from either
	 * end's full party, and where the two events sit in different columns. A hop
	 * straight down the same column is just "what happens next" and needs no arrow.
	 */
	let anchorHops = $derived(
		anchorLayout.flows.filter((f) => {
			const from = eventById.get(f.from);
			const to = eventById.get(f.to);
			if (!from || !to) return false;
			const a = anchorLayout.placed.get(f.from);
			const b = anchorLayout.placed.get(f.to);
			if (!a || !b || a.col === b.col) return false;
			return f.people.length < from.people.length || f.people.length < to.people.length;
		})
	);

	/**
	 * SVG text can't wrap or ellipsize, so a twenty-person merge would otherwise
	 * paint its whole roster across the board. Name a couple of people, count the rest.
	 */
	function hopLabel(people: string[]): string {
		if (people.length <= 3) return people.map((p) => shortName(p)).join(', ');
		return `${people.slice(0, 2).map((p) => shortName(p)).join(', ')} +${people.length - 2}`;
	}

	/** Compact attendee text for dense single-line rows (agenda). */
	function peopleLabel(ids: string[], max = 3): string {
		if (ids.length === data.members.length) return 'Everyone';
		const names = ids.map((a) => memberName.get(a) ?? '?');
		if (names.length <= max) return names.join(', ');
		return `${names.slice(0, max).join(', ')} +${names.length - max}`;
	}

	/** Measured width of the day board's event area, for positioning arrows. */
	let laneW = $state(0);

	/**
	 * Blocks clip their overflow, so on a five-room morning names end up sliced
	 * in half. Budget the space instead: the title is clamped to `trows` lines
	 * and the chips to `wrows` rows, both 15px, so the content is guaranteed to
	 * fit. Anything past the budget collapses into a `+N` chip.
	 */
	function whoBudget(widthFrac: number, mins: number, title: string, lanePx: number) {
		const px = Math.max(36, widthFrac * lanePx - 16);
		const trows = Math.min(3, Math.max(1, Math.ceil((title.length * 7) / px)));
		const perRow = Math.max(1, Math.floor(px / 48));
		const free = mins * pxPerMin - 14 - 16 - trows * 15;
		const wrows = Math.max(0, Math.min(4, Math.floor(free / 15)));
		return {
			trows,
			wrows,
			fit: wrows * perRow,
			compact: px < 150,
			showTime: px >= 92,
			showTag: px >= 58
		};
	}

	/**
	 * Swimlane data: one continuous row per person across the day. Splits and
	 * rejoins are visible directly: bands diverge into different colours and
	 * converge again, so no extra connector drawing is needed.
	 */
	let swimPeople = $derived(viewAs ? data.members.filter((m) => m.id === viewAs) : data.members);
	let swimBands = $derived(
		personBands(
			anchorEvents.map((e) => ({
				id: e.id,
				start: e.start_min,
				end: e.end_min,
				people: e.people
			})),
			swimPeople.map((m) => m.id),
			dayStart,
			dayEnd
		)
	);
	/** Horizontal position helpers for the swimlane (percent of the day span). */
	function pctLeft(min: number): number {
		return ((clampMin(min) - dayStart) / (dayEnd - dayStart)) * 100;
	}
	function pctWidth(start: number, end: number): number {
		return ((clampMin(end) - clampMin(start)) / (dayEnd - dayStart)) * 100;
	}

	// Which crew's lens are we viewing a day through? Without "view as", the
	// default Everyone party. With it, the crew the viewer belongs to that day
	// (the segment running latest into the day; else Everyone).
	let defaultParty = $derived(data.parties.find((p) => p.isDefault)?.id ?? null);
	function viewerParty(
		membership: { partyId: string; userId: string; endMin: number }[]
	): string | null {
		if (!viewAs) return defaultParty;
		const mine = membership.filter((m) => m.userId === viewAs);
		if (!mine.length) return defaultParty;
		return mine.reduce((a, b) => (b.endMin > a.endMin ? b : a)).partyId;
	}
	function cellFor(entry: (typeof data.board)[number]) {
		const pid = viewerParty(entry.membership);
		const cell = pid ? entry.partyCells[pid] : null;
		return cell ?? { city: entry.city, lodging: entry.lodging };
	}
	// The anchor day's city seen through the viewer's crew (drives map + zone chip).
	let anchorCityView = $derived(anchor ? cellFor(anchor).city : data.dayCity);

	let showAddTrack = $state(false);
	let showSchedule = $state(false);
	let showCrews = $state(false);

	// Crew (party) management state.
	let newCrewName = $state('');
	let addTrackParty = $state(''); // '' = Everyone
	let assignMembers = $state<string[]>([]);
	let assignFrom = $state(String(dayStart));
	let assignPartyId = $state('');
	let crewCity = $state<Record<string, string>>({});

	let everyoneParty = $derived(data.parties.find((p) => p.isDefault) ?? null);
	let crews = $derived(data.parties.filter((p) => !p.isDefault));
	let anchorMembership = $derived(anchor?.membership ?? []);
	// The crew a member ends the anchor day with (their end-of-day location).
	function endOfDayParty(userId: string): string | null {
		const mine = anchorMembership.filter((m) => m.userId === userId);
		if (!mine.length) return defaultParty;
		return mine.reduce((a, b) => (b.endMin > a.endMin ? b : a)).partyId;
	}
	function membersOf(partyId: string | null): { id: string; name: string }[] {
		return data.members.filter((m) => endOfDayParty(m.id) === partyId);
	}
	let cityChoices = $derived([
		{ value: '', label: 'Default (trip)' },
		...data.cities.map((c) => ({ value: c.id, label: c.name }))
	]);
	// Track's crew picker: Everyone is the empty value (server defaults to it).
	let trackPartyChoices = $derived(
		data.parties.map((p) => ({ value: p.isDefault ? '' : p.id, label: p.name }))
	);
	let crewAssignChoices = $derived(crews.map((p) => ({ value: p.id, label: p.name })));

	// Seed the per-crew city pickers from the resolved city whenever the day changes.
	$effect(() => {
		const next: Record<string, string> = {};
		for (const c of crews) next[c.id] = anchor?.partyCells[c.id]?.city?.id ?? '';
		crewCity = next;
	});

	function clampMin(v: number): number {
		return Math.max(dayStart, Math.min(v, dayEnd));
	}

	/**
	 * Split / rejoin moments for the day, derived from the event flow graph rather
	 * than from crew membership, since the events' attendee lists are the single source
	 * of truth for who is where. A moment is a "split" when one event feeds several,
	 * a "rejoin" when several feed one, and a "move" otherwise.
	 */
	let switchLines = $derived.by(() => {
		const byMin = new Map<number, typeof anchorHops>();
		for (const h of anchorHops) {
			const arr = byMin.get(h.at) ?? [];
			arr.push(h);
			byMin.set(h.at, arr);
		}
		return [...byMin.entries()]
			.map(([min, hops]) => {
				const froms = new Set(hops.map((h) => h.from));
				const tos = new Set(hops.map((h) => h.to));
				const kind: 'split' | 'rejoin' | 'move' =
					froms.size === 1 && tos.size > 1 ? 'split' : tos.size === 1 && froms.size > 1 ? 'rejoin' : 'move';
				const movers = [...new Set(hops.flatMap((h) => h.people))];
				const verb = { split: 'split off', rejoin: 'rejoin', move: 'switch' } as const;
				const label =
					movers.length === 1
						? `${shortName(movers[0])} → ${eventById.get(hops[0].to)?.title ?? 'elsewhere'}`
						: `${movers.length} people ${verb[kind]}`;
				const detail = hops
					.map(
						(h) =>
							`${h.people.map((p) => shortName(p)).join(', ')}: ` +
							`${eventById.get(h.from)?.title ?? '?'} → ${eventById.get(h.to)?.title ?? '?'}`
					)
					.join('\n');
				return { min, kind, label, detail };
			})
			.sort((a, b) => a.min - b.min);
	});

	const viewOptions = [
		{ v: 'day', label: 'Day' },
		{ v: '3day', label: '3-day' },
		{ v: 'people', label: 'People' },
		{ v: 'agenda', label: 'Agenda' }
	];
	function navUrl(day: string, view: string): string {
		return `?day=${day}&view=${view}`;
	}
	function shiftDayClient(iso: string, delta: number): string {
		const [y, m, d] = iso.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
	}

	// Live clock for the destination city's zone.
	let now = $state(new Date());
	onMount(() => {
		const id = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(id);
	});

	/**
	 * Minutes-since-midnight for the "now" line on `day`, or null when that day
	 * isn't today in the destination's zone (or now falls outside 8:00–18:00).
	 */
	function nowLineFor(day: string, tz: string | null | undefined): number | null {
		if (!tz) return null;
		const local = localDayMinutes(tz, now);
		if (local.day !== day) return null;
		if (local.minutes < dayStart || local.minutes > dayEnd) return null;
		return local.minutes;
	}

	// Build "H:MM" options every 15 min across the visible day (5-min snapping still
	// applies on drag; 15-min steps keep the picker short).
	const startOptions = Array.from({ length: (dayEnd - dayStart) / 15 + 1 }, (_, i) => dayStart + i * 15);
	const startSelectOptions = startOptions.map((s) => ({ value: String(s), label: hhmm(s) }));

	const itemTypes = [
		{ value: 'poi', label: 'Sight' },
		{ value: 'food', label: 'Food' },
		{ value: 'transport', label: 'Transport' },
		{ value: 'travel', label: 'Travel' },
		{ value: 'lodging', label: 'Lodging' },
		{ value: 'freetime', label: 'Free time' }
	];
	const durationOptions = [
		{ value: '15', label: '15m' },
		{ value: '30', label: '30m' },
		{ value: '45', label: '45m' },
		{ value: '60', label: '1h' },
		{ value: '90', label: '1h 30m' },
		{ value: '120', label: '2h' },
		{ value: '180', label: '3h' },
		{ value: '240', label: '4h' }
	];
	const travelOptions = [
		{ value: '0', label: 'None' },
		{ value: '10', label: '10m' },
		{ value: '15', label: '15m' },
		{ value: '30', label: '30m' },
		{ value: '45', label: '45m' },
		{ value: '60', label: '1h' }
	];
	let trackOptions = $derived(anchorTracks.map((t) => ({ value: t.id, label: t.name })));
	let poiOptions = $derived([
		{ value: '', label: 'No place (custom)' },
		...data.saved.map((p) => ({ value: p.id, label: p.name }))
	]);

	// Controlled fields for the schedule add form (so templates can prefill them).
	let schedTitle = $state('');
	let schedType = $state('poi');
	let schedDuration = $state('60');
	let schedTravel = $state('0');
	let schedPoi = $state('');
	let schedTrack = $state('');
	let schedStart = $state(String(9 * 60));
	let schedAssignees = $state<string[]>([]);
	// Keep the track selection valid as days/tracks change.
	$effect(() => {
		if (anchorTracks.length && !anchorTracks.some((t) => t.id === schedTrack)) {
			schedTrack = anchorTracks[0].id;
		}
	});

	// One-click standard slots. Clicking prefills title, type, and length.
	const templates = [
		{ label: 'Flight', type: 'transport', title: 'Flight', duration: '180' },
		{ label: 'Travel', type: 'travel', title: 'Travel', duration: '30' },
		{ label: 'Breakfast', type: 'food', title: 'Breakfast', duration: '60' },
		{ label: 'Lunch', type: 'food', title: 'Lunch', duration: '60' },
		{ label: 'Dinner', type: 'food', title: 'Dinner', duration: '90' },
		{ label: 'Coffee', type: 'food', title: 'Coffee break', duration: '30' },
		{ label: 'Free time', type: 'freetime', title: 'Free time', duration: '120' },
		{ label: 'Hotel', type: 'lodging', title: 'Hotel check-in', duration: '60' }
	];
	function applyTemplate(t: { title: string; type: string; duration: string }) {
		schedTitle = t.title;
		schedType = t.type;
		schedDuration = t.duration;
	}
	function resetSched() {
		schedTitle = '';
		schedType = 'poi';
		schedDuration = '60';
		schedTravel = '0';
		schedPoi = '';
		schedAssignees = [];
		schedStart = String(9 * 60);
	}
</script>

<div class="toolbar">
	<div class="navgroup">
		<div class="daynav">
			<a class="navbtn" href={navUrl(shiftDayClient(data.day, -1), data.view)} aria-label="Previous day">‹</a>
			<span class="curday">{dayLabel(data.day)}</span>
			<a class="navbtn" href={navUrl(shiftDayClient(data.day, 1), data.view)} aria-label="Next day">›</a>
		</div>
		<div class="viewswitch">
			{#each viewOptions as o}
				<a class="vbtn" class:on={o.v === data.view} href={navUrl(data.day, o.v)}>{o.label}</a>
			{/each}
		</div>
	</div>
	<div class="tools">
		{#if anchorCityView}
			<span class="zone" title="Schedule times are in {anchorCityView.name} local time">
				<span class="zdot"></span>
				{anchorCityView.name} · {localTime(anchorCityView.tz, now)} {zoneAbbr(anchorCityView.tz, now)}
			</span>
		{/if}
		<div class="viewas" title="Show one person's schedule">
			<span class="vaicon" aria-hidden="true">👤</span>
			<Select bind:value={viewAs} options={viewAsOptions} ariaLabel="View schedule as" compact />
		</div>
		<button class="btn" onclick={() => (showCrews = true)}>Crews</button>
		<button class="btn" onclick={() => (showAddTrack = !showAddTrack)}>+ Add track</button>
		<button
			class="btn primary"
			disabled={anchorTracks.length === 0}
			onclick={() => (showSchedule = !showSchedule)}>+ Event</button
		>
	</div>
</div>

{#if showAddTrack}
	<form
		class="addtrack card"
		method="POST"
		action="?/addTrack"
		use:enhance={() => async ({ update }) => {
			await update();
			showAddTrack = false;
		}}
	>
		<input type="hidden" name="day" value={data.day} />
		<input name="name" placeholder="Track name, e.g. Museum group" />
		{#if crews.length}
			<input type="hidden" name="partyId" value={addTrackParty} />
			<Select
				bind:value={addTrackParty}
				options={trackPartyChoices}
				ariaLabel="Crew for this track"
				compact
			/>
		{/if}
		<button class="btn primary" type="submit">Add</button>
	</form>
{/if}

{#if showSchedule && anchorTracks.length > 0}
	<Modal
		open={showSchedule}
		title="Add event"
		subtitle={dayLabel(data.day)}
		size="lg"
		onclose={() => (showSchedule = false)}
	>
			<form
				class="mform schedule"
				method="POST"
				action="?/addItem"
				use:enhance={() => async ({ update }) => {
					await update({ reset: true });
					resetSched();
					showSchedule = false;
				}}
			>
			<div class="mbody">
				<div class="templates">
			<span class="tlabel muted">Quick add:</span>
			{#each templates as t}
				<button type="button" class="chip" onclick={() => applyTemplate(t)}>{t.label}</button>
			{/each}
		</div>

		<input type="hidden" name="poiId" value={schedPoi} />
		<input type="hidden" name="type" value={schedType} />
		<input type="hidden" name="trackId" value={schedTrack} />
		<input type="hidden" name="start" value={schedStart} />
		<input type="hidden" name="duration" value={schedDuration} />
		<input type="hidden" name="travelBefore" value={schedTravel} />
		<input type="hidden" name="assignees" value={schedAssignees.join(',')} />

		<div class="srow">
			<label class="grow">
				<span>Title</span>
				<input name="title" placeholder="e.g. Escape room at The Vault" bind:value={schedTitle} use:focusOnMount />
			</label>
			<label class="grow">
				<span>Place {schedType === 'freetime' ? '(n/a for free time)' : ''}</span>
				<Select
					bind:value={schedPoi}
					options={poiOptions}
					placeholder="No place (custom)"
					ariaLabel="Place"
				/>
			</label>
			<label class="tf2">
				<span>Type</span>
				<Select bind:value={schedType} options={itemTypes} ariaLabel="Activity type" />
			</label>
		</div>

		<div class="srow">
			<label class="tftrack">
				<span>Track</span>
				<Select bind:value={schedTrack} options={trackOptions} ariaLabel="Track" />
			</label>
			<label class="tf2">
				<span>Start</span>
				<Select bind:value={schedStart} options={startSelectOptions} ariaLabel="Start time" />
			</label>
			<label class="tf2">
				<span>Length</span>
				<Select bind:value={schedDuration} options={durationOptions} ariaLabel="Length" />
			</label>
			<label class="tf2">
				<span>Travel before</span>
				<Select bind:value={schedTravel} options={travelOptions} ariaLabel="Travel before" />
			</label>
			<label class="tf3">
				<span>Assign to</span>
				<MultiSelect bind:selected={schedAssignees} options={memberOptions} placeholder="Everyone" />
			</label>
		</div>

		<div class="sactions">
			<span class="muted hint-inline"
				>Pick a place to carry its location (and onward travel times). Add a title for what you'll
				do there, handy when one place has several activities. Assign people, or leave as everyone.</span
			>
		</div>
			</div>
			<div class="mfoot">
				<button class="btn" type="button" onclick={() => (showSchedule = false)}>Cancel</button>
				<button class="btn primary" type="submit">Add to schedule</button>
			</div>
			</form>
	</Modal>
{/if}

{#snippet lodgingBanner(lodging: { name: string; tag: string; locked: number; url: string | null } | null)}
	{#if lodging}
		<div class="lodgeband" class:locked={lodging.locked}>
			<span class="lodgeicon" aria-hidden="true">🛏</span>
			<span class="lodgename">{lodging.name}</span>
			{#if lodging.tag}<span class="lodgetag">{lodging.tag}</span>{/if}
			{#if lodging.locked}<span class="lodgepick">Booked stay</span>{:else}<span class="muted small">top pick</span>{/if}
			{#if lodging.url}<a class="lodgelink" href={lodging.url} target="_blank" rel="noopener">Details</a>{/if}
		</div>
	{/if}
{/snippet}

{#snippet switchStrip()}
	{#if switchLines.length}
		<div class="switchbar daybar">
			<span class="switchcap muted small">Crew changes today</span>
			{#each switchLines as sw}
				<span class="switchpill {sw.kind}" title={sw.detail}>
					<span class="swico" aria-hidden="true"
						>{sw.kind === 'rejoin' ? '⇄' : sw.kind === 'move' ? '→' : '⋔'}</span
					><b>{hhmm(sw.min)}</b> {sw.label}</span
				>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet eventBoard(
	events: DayEvent[],
	place: ReturnType<typeof layoutFor>,
	switches: typeof switchLines = [],
	day: string = data.day,
	tz: string | null = anchorCityView?.tz ?? null,
	hops: typeof anchorHops = [],
	measure = false,
	lanePx = 0
)}
	{#if events.length === 0}
		<div class="empty">
			<p>Nothing scheduled for this day.</p>
			<p class="muted">
				Add an event to start planning. Two events at the same time are laid out side by side.
			</p>
		</div>
	{:else}
		<div class="tracks" style={`height:${headPx + (dayEnd - dayStart) * pxPerMin + 20}px`}>
			<div class="axis">
				{#each hours as h}
					<div class="hourline" style={`top:${(h * 60 - dayStart) * pxPerMin}px`}>
						<span>{h}:00</span>
					</div>
				{/each}
			</div>

			<!-- crew split / rejoin moments, drawn across the whole board -->
			{#each switches as sw}
				<div
					class="switchline {sw.kind}"
					style={`top:${headPx + (clampMin(sw.min) - dayStart) * pxPerMin}px`}
					title={sw.detail}
				>
					<span class="switchtag">{hhmm(sw.min)} · {sw.label}</span>
				</div>
			{/each}

			<!-- live "now" line, only on the day that is current in the city's zone -->
			{#if nowLineFor(day, tz) !== null}
				{@const nm = nowLineFor(day, tz) ?? 0}
				<div class="nowline" style={`top:${headPx + (nm - dayStart) * pxPerMin}px`}>
					<span class="nowtag">{hhmm(nm)}</span>
				</div>
			{/if}

			<div class="lane">
				{#if measure}
					<div class="lanemeasure" bind:clientWidth={laneW}></div>
				{/if}

				<!-- people-flow arrows: who peels off where, and who rejoins -->
				{#if hops.length && laneW > 0}
					<svg
						class="flowlayer"
						viewBox={`0 0 ${laneW} ${(dayEnd - dayStart) * pxPerMin}`}
						width={laneW}
						height={(dayEnd - dayStart) * pxPerMin}
						aria-hidden="true"
					>
						<defs>
							<marker
								id="hoparrow"
								viewBox="0 0 8 8"
								refX="6"
								refY="4"
								markerWidth="6"
								markerHeight="6"
								orient="auto"
							>
								<path d="M0 0 L8 4 L0 8 z" fill="#6f6455" />
							</marker>
						</defs>
						{#each hops as hop}
							{@const a = place.placed.get(hop.from)}
							{@const b = place.placed.get(hop.to)}
							{@const ea = eventById.get(hop.from)}
							{@const eb = eventById.get(hop.to)}
							{#if a && b && ea && eb}
								{@const x1 = (a.left + a.width / 2) * laneW}
								{@const x2 = (b.left + b.width / 2) * laneW}
								{@const y1 = (clampMin(ea.end_min) - dayStart) * pxPerMin}
								{@const y2 = (clampMin(eb.start_min) - dayStart) * pxPerMin}
								{@const dy = Math.max(18, Math.abs(y2 - y1) / 2)}
								{@const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`}
								<path class="hophalo" {d} />
								<path class="hoppath" {d} marker-end="url(#hoparrow)" />
								<text class="hopcount" x={(x1 + x2) / 2} y={(y1 + y2) / 2 + dy / 2}>
									<title>{hop.people.map((p) => shortName(p)).join(', ')}</title>
									{hopLabel(hop.people)}
								</text>
							{/if}
						{/each}
					</svg>
				{/if}

				{#each events as item (item.id)}
					{@const p = place.placed.get(item.id)}
					{#if p}
						{@const box = `left:${p.left * 100}%;width:calc(${p.width * 100}% - 6px)`}
						{@const bud = whoBudget(
							p.width,
							endFor(item) - startFor(item),
							item.title,
							lanePx || 560
						)}
						{#if item.travel_before_min}
							<div
								class="buffer"
								title={`${item.travel_before_min} min travel before`}
								style={`${box};top:${(startFor(item) - item.travel_before_min - dayStart) * pxPerMin}px;height:${item.travel_before_min * pxPerMin}px;--c:${item.trackColor}`}
							>
								<span>{item.travel_before_min}m travel</span>
							</div>
						{/if}
						<div
							class="block {item.type}"
							role="button"
							tabindex="0"
							aria-label={`${item.title}, ${hhmm(item.start_min)} to ${hhmm(item.end_min)}. Click to open, drag to reschedule.`}
							class:unbooked={item.booking === 'unbooked'}
							class:dragging={drag?.id === item.id}
							class:resizing={resize?.id === item.id}
							class:editingnow={detail?.id === item.id}
							class:narrow={p.width < 0.34}
							style={`${box};top:${(startFor(item) - dayStart) * pxPerMin}px;height:${(endFor(item) - startFor(item)) * pxPerMin}px;--c:${item.trackColor};--trows:${bud.trows};--wrows:${bud.wrows}`}
							onpointerdown={(e) => onPointerDown(e, item)}
							onpointermove={onPointerMove}
							onpointerup={onPointerUp}
							onclick={(e) => {
								if ((e.target as HTMLElement).closest('.tag, .bdel, .bresize')) return;
								openDetail(item, {
									id: item.trackId,
									name: item.trackName,
									color: item.trackColor
								});
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									openDetail(item, {
										id: item.trackId,
										name: item.trackName,
										color: item.trackColor
									});
								}
							}}
						>
							<div class="bt">{item.title}</div>
							<div class="bmeta">
								{#if bud.showTime}
									<span>
										{#if bud.compact}{hhmm(startFor(item))}{:else}{hhmm(startFor(item))}-{hhmm(
												endFor(item)
											)}{/if}
									</span>
								{/if}
								{#if item.booking && bud.showTag}
									<button class="tag {item.booking}" onclick={() => cycle(item.id)}>{item.booking}</button>
								{/if}
							</div>
							<div class="bwho">
								{#if item.people.length === data.members.length}
									<span class="who all">Everyone</span>
								{:else if item.people.length <= bud.fit}
									{#each item.people as a}
										<span class="who">{shortName(a)}</span>
									{/each}
								{:else if bud.fit > 0}
									{#each item.people.slice(0, bud.fit - 1) as a}
										<span class="who">{shortName(a)}</span>
									{/each}
									<span class="who more" title={item.people.map((a) => shortName(a)).join(', ')}>
										+{item.people.length - (bud.fit - 1)}
									</span>
								{/if}
							</div>
							<button class="bdel" title="Remove" aria-label="Remove item" onclick={() => del(item.id)}>×</button>
							<div
								class="bresize"
								role="separator"
								aria-label="Drag to change end time"
								onpointerdown={(e) => onResizeDown(e, item)}
								onpointermove={onResizeMove}
								onpointerup={onResizeUp}
							></div>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	{/if}
{/snippet}

{#snippet swimlane()}
	{#if anchorEvents.length === 0}
		<div class="empty">
			<p>Nothing scheduled for this day.</p>
			<p class="muted">Add an event and each person's day will appear as a band here.</p>
		</div>
	{:else}
		<div class="swim">
			<div class="swimhead">
				<span class="swimname"></span>
				<div class="swimaxis">
					{#each hours as h}
						<span class="swimhour" style={`left:${pctLeft(h * 60)}%`}>{h}:00</span>
					{/each}
				</div>
			</div>

			<div class="swimbody">
				<!-- one overlay for the whole board: split / rejoin moments and "now" -->
				<div class="swimlines">
					{#each switchLines as sw}
						<span class="swimswitch {sw.kind}" style={`left:${pctLeft(sw.min)}%`} title={sw.detail}>
							<span class="swimswtag">{hhmm(sw.min)}</span>
						</span>
					{/each}
					{#if nowLineFor(data.day, anchorCityView?.tz ?? null) !== null}
						<span
							class="swimnow"
							style={`left:${pctLeft(nowLineFor(data.day, anchorCityView?.tz ?? null) ?? 0)}%`}
						></span>
					{/if}
				</div>

				{#each swimPeople as person}
					<div class="swimrow">
						<span class="swimname" title={memberName.get(person.id)}>{shortName(person.id)}</span>
						<div class="swimtrack">
							{#each hours as h}
								<span class="swimgrid" style={`left:${pctLeft(h * 60)}%`}></span>
							{/each}

							{#each swimBands.get(person.id) ?? [] as band}
								{@const ev = band.eventId ? eventById.get(band.eventId) : null}
								{#if ev}
									<button
										class="swimband {ev.type}"
										style={`left:${pctLeft(band.start)}%;width:${pctWidth(band.start, band.end)}%;--c:${ev.trackColor}`}
										title={`${ev.title} · ${hhmm(ev.start_min)}–${hhmm(ev.end_min)}\nWith: ${ev.people.map((p) => shortName(p)).join(', ')}`}
										onclick={() =>
											openDetail(ev, { id: ev.trackId, name: ev.trackName, color: ev.trackColor })}
									>
										<span class="swimlabel">{ev.title}</span>
									</button>
								{:else}
									<span
										class="swimfree"
										style={`left:${pctLeft(band.start)}%;width:${pctWidth(band.start, band.end)}%`}
										title={`Free ${hhmm(band.start)}–${hhmm(band.end)}`}
									></span>
								{/if}
							{/each}
						</div>
					</div>
				{/each}
			</div>

			<p class="swimhint muted small">
				Each row is one person's day. Where rows change colour at the same moment, the group split
				or came back together.
			</p>
		</div>
	{/if}
{/snippet}

{#snippet agendaDay(entry: (typeof data.board)[number])}
	<div class="agday">
		<div class="agdayhead">
			<a href={navUrl(entry.day, 'day')}>{dayLabel(entry.day)}</a>
			{#if cellFor(entry).city}<span class="muted">{cellFor(entry).city?.name}</span>{/if}
			{#if cellFor(entry).lodging}<span class="aglodge">🛏 {cellFor(entry).lodging?.name}</span>{/if}
		</div>
		{#if entry.tracks.length === 0 || entry.tracks.every((t) => t.items.length === 0)}
			<p class="muted small agempty">Nothing scheduled.</p>
		{:else}
			{#each entry.tracks as track}
				{#if track.items.length}
					<div class="agtrack">
						<span class="agswatch" style={`background:${track.color}`}></span>
						<span class="agtname">{track.name}</span>
					</div>
					<ul class="aglist">
						{#each track.items as item}
							<li>
								<span class="agtime">{hhmm(item.start_min)}–{hhmm(item.end_min)}</span>
								<span class="agtitle">{item.title}</span>
								{#if item.assignees.length}<span
										class="agwho muted small"
										title={item.assignees.map((a) => memberName.get(a) ?? '?').join(', ')}
										>{peopleLabel(item.assignees)}</span
									>{/if}
								{#if item.travel_mins != null}<span class="muted small">{item.travel_mode} · {item.travel_mins}m to next</span>{/if}
								{#if item.booking}<span class="tag {item.booking}">{item.booking}</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/each}
		{/if}
	</div>
{/snippet}

<div class="split" class:wide={data.view === '3day' || data.view === 'people' || data.view === 'agenda'}>
	<div class="boardcol">
		{#if data.view === 'agenda'}
			<div class="agenda card">
				{#each filteredBoard as entry}
					{@render agendaDay(entry)}
				{/each}
			</div>
		{:else if data.view === 'people'}
			<div class="board card">
				{@render lodgingBanner(filteredAnchor ? cellFor(filteredAnchor).lodging : null)}
				{@render switchStrip()}
				{@render swimlane()}
			</div>
		{:else if data.view === 'day'}
			<div class="board card">
				{@render lodgingBanner(filteredAnchor ? cellFor(filteredAnchor).lodging : null)}
				{@render switchStrip()}
				{@render eventBoard(
					anchorEvents,
					anchorLayout,
					switchLines,
					data.day,
					anchorCityView?.tz ?? null,
					anchorHops,
					true,
					laneW
				)}
			</div>
		{:else}
			<div class="multiboard">
				{#each filteredBoard as entry}
					{@const evs = eventsFor(entry)}
					<div class="board card dayblock">
						<div class="dayblockhead">
							<a class="dayblocklink" href={navUrl(entry.day, 'day')}>{dayLabel(entry.day)}</a>
							{#if cellFor(entry).city}<span class="muted">{cellFor(entry).city?.name}</span>{/if}
						</div>
						{@render lodgingBanner(cellFor(entry).lodging)}
						{@render eventBoard(
							evs,
							layoutFor(evs),
							[],
							entry.day,
							cellFor(entry).city?.tz ?? null,
							[],
							false,
							250
						)}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#if data.view !== '3day' && data.view !== 'people' && data.view !== 'agenda'}
		<aside class="mapwrap card">
		{#if data.mapsKey}
			<GoogleMap tracks={mapTracks} apiKey={data.mapsKey} center={anchorCityView} />
		{:else}
			<TripMap tracks={mapTracks} />
		{/if}
		<div class="legs">
			{#if poiPinTrack}
				<p class="maplegend muted small"><span class="dotmark"></span> Discovered places (not yet scheduled)</p>
			{/if}
			<h4>Travel legs</h4>
			{#if legs.length}
				<ul>
					{#each legs as l}
						<li class:warn-leg={l.tight}>
							<span>{l.title}</span><span class:muted={!l.tight}>{l.mode} · {l.mins}m</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted small">No travel legs yet.</p>
			{/if}
			<p class="hint muted">Click a block to open its details. Drag to reschedule, drag the bottom edge to resize. Click its status to cycle booked, tentative, unbooked.</p>
		</div>
	</aside>
	{/if}
</div>

<!-- Escape is handled per-dialog by the native <dialog> element. -->

{#if detail}
	<Modal
		open={!!detail}
		title="Event details"
		subtitle={`${detail.trackName} · ${dayLabel(data.day)}`}
		swatch={detail.trackColor}
		size="md"
		onclose={() => (detail = null)}
	>
			<form
				class="mform schedule"
				onsubmit={(e) => {
					e.preventDefault();
					saveDetail();
				}}
			>
				<div class="mbody">
				<div class="srow">
					<label class="grow">
						<span>Title</span>
						<input bind:value={detail.title} use:focusOnMount />
					</label>
					<label>
						<span>Type</span>
						<Select bind:value={detail.type} options={itemTypes} ariaLabel="Type" />
					</label>
				</div>

				<div class="srow">
					<label>
						<span>Start</span>
						<Select bind:value={detail.start} options={startSelectOptions} ariaLabel="Start time" />
					</label>
					<label>
						<span>Duration</span>
						<Select bind:value={detail.duration} options={durationOptions} ariaLabel="Duration" />
					</label>
					<label>
						<span>Travel before</span>
						<Select
							bind:value={detail.travelBefore}
							options={editTravelOptions}
							ariaLabel="Travel before"
						/>
					</label>
				</div>

				<div class="srow">
					<label class="grow">
						<span>Who's going</span>
						<MultiSelect
							bind:selected={detail.assignees}
							options={memberOptions}
							placeholder="Everyone on this track"
						/>
					</label>
				</div>

				<div class="dfacts">
					<span class="dfact"
						>🕑 {hhmm(Number(detail.start))}–{hhmm(Number(detail.start) + Number(detail.duration))}
						{#if anchorCityView}<span class="muted">· {anchorCityView.name} time</span>{/if}
					</span>
					{#if detail.travelMins != null}
						<span class="dfact">🚇 {detail.travelMode} · {detail.travelMins}m to next stop</span>
					{/if}
					{#if detail.booking}
						<button type="button" class="tag {detail.booking}" onclick={cycleDetail}
							>{detail.booking}</button
						>
					{/if}
				</div>
				</div>

				<div class="mfoot">
					<button
						type="button"
						class="btn danger mfoot-note"
						onclick={() => {
							const id = detail?.id;
							detail = null;
							if (id) del(id);
						}}>Delete</button
					>
					<button type="button" class="btn" onclick={() => (detail = null)}>Cancel</button>
					<button class="btn primary" type="submit" disabled={detail.saving}
						>{detail.saving ? 'Saving…' : 'Save'}</button
					>
				</div>
			</form>
	</Modal>
{/if}

{#if showCrews}
	<Modal
		open={showCrews}
		title="Crews"
		subtitle={dayLabel(data.day)}
		size="md"
		onclose={() => (showCrews = false)}
	>
		<div class="mbody crewbody">
			<p class="muted small crewintro">
				Split the group into crews. A crew can be in a different city and keep its own tracks; use
				"View as" to see one person's day.
			</p>

			<form
				class="crewnew"
				method="POST"
				action="?/createCrew"
				use:enhance={() => async ({ update }) => {
					await update();
					newCrewName = '';
				}}
			>
				<input name="name" placeholder="New crew, e.g. Museum group" bind:value={newCrewName} use:focusOnMount />
				<button class="btn primary" type="submit" disabled={!newCrewName.trim()}>Add crew</button>
			</form>

			<!-- Everyone -->
			<div class="crewcard">
				<div class="crewhd">
					<span class="swatch" style={`background:${everyoneParty?.color ?? '#2f6d5e'}`}></span>
					<strong>Everyone</strong>
					<span class="muted small">base group</span>
				</div>
				<div class="crewmem">
					{#each membersOf(everyoneParty?.id ?? null) as m}
						<span class="memchip">{m.name}</span>
					{:else}
						<span class="muted small">Nobody here right now.</span>
					{/each}
				</div>
			</div>

			<!-- Crews -->
			{#each crews as crew}
				<div class="crewcard">
					<div class="crewhd">
						<span class="swatch" style={`background:${crew.color}`}></span>
						<form
							class="crewrename"
							method="POST"
							action="?/editCrew"
							use:enhance={() => async ({ update }) => await update()}
						>
							<input type="hidden" name="partyId" value={crew.id} />
							<input name="name" value={crew.name} aria-label="Crew name" />
							<input type="color" name="color" value={crew.color} aria-label="Crew color" />
							<button class="btn small" type="submit">Save</button>
						</form>
						<form
							method="POST"
							action="?/deleteCrew"
							use:enhance={() => async ({ update }) => await update()}
						>
							<input type="hidden" name="partyId" value={crew.id} />
							<button class="btn small danger" type="submit" title="Delete crew">Delete</button>
						</form>
					</div>

					<form
						class="crewday"
						method="POST"
						action="?/setCrewDay"
						use:enhance={() => async ({ update }) => await update()}
					>
						<input type="hidden" name="partyId" value={crew.id} />
						<input type="hidden" name="day" value={data.day} />
						<input type="hidden" name="cityId" value={crewCity[crew.id] ?? ''} />
						<span class="muted small">City today</span>
						<Select bind:value={crewCity[crew.id]} options={cityChoices} ariaLabel="Crew city" compact />
						<button class="btn small" type="submit">Set</button>
					</form>

					<div class="crewmem">
						{#each membersOf(crew.id) as m}
							<span class="memchip">
								{m.name}
								<form
									method="POST"
									action="?/rejoin"
									use:enhance={() => async ({ update }) => await update()}
								>
									<input type="hidden" name="day" value={data.day} />
									<input type="hidden" name="fromMin" value={dayStart} />
									<input type="hidden" name="userIds" value={m.id} />
									<button
										class="rejoin"
										type="submit"
										title="Return to Everyone"
										aria-label={`Return ${m.name} to Everyone`}>×</button
									>
								</form>
							</span>
						{:else}
							<span class="muted small">No one assigned.</span>
						{/each}
					</div>
				</div>
			{/each}

			<!-- Split people off into a crew -->
			{#if crews.length}
				<form
					class="splitform"
					method="POST"
					action="?/splitOff"
					use:enhance={() => async ({ update }) => {
						await update();
						assignMembers = [];
					}}
				>
					<input type="hidden" name="day" value={data.day} />
					<input type="hidden" name="userIds" value={assignMembers.join(',')} />
					<input type="hidden" name="partyId" value={assignPartyId} />
					<input type="hidden" name="fromMin" value={assignFrom} />
					<div class="splithd"><strong>Split people off</strong></div>
					<div class="splitgrid">
						<label>
							<span class="muted small">People</span>
							<MultiSelect
								bind:selected={assignMembers}
								options={memberOptions}
								placeholder="Choose people"
								ariaLabel="People to split off"
							/>
						</label>
						<label>
							<span class="muted small">Into crew</span>
							<Select bind:value={assignPartyId} options={crewAssignChoices} ariaLabel="Target crew" />
						</label>
						<label>
							<span class="muted small">From</span>
							<Select bind:value={assignFrom} options={startSelectOptions} ariaLabel="Split start time" />
						</label>
					</div>
					<button
						class="btn primary"
						type="submit"
						disabled={!assignMembers.length || !assignPartyId}>Split off</button
					>
				</form>
			{/if}
		</div>
		<div class="mfoot">
			<button class="btn" type="button" onclick={() => (showCrews = false)}>Done</button>
		</div>
	</Modal>
{/if}

<style>
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.2rem;
	}
	.navgroup {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.daynav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.navbtn {
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink-soft);
		font-size: 1.1rem;
		line-height: 1;
		text-decoration: none;
	}
	.navbtn:hover {
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.curday {
		font-family: var(--serif);
		font-size: 1.1rem;
		min-width: 8rem;
		text-align: center;
	}
	.viewswitch {
		display: inline-flex;
		border: 1px solid var(--line);
		border-radius: 999px;
		overflow: hidden;
	}
	.vbtn {
		padding: 0.35rem 0.8rem;
		font-size: 0.82rem;
		color: var(--ink-soft);
		text-decoration: none;
		border-right: 1px solid var(--line);
	}
	.vbtn:last-child {
		border-right: none;
	}
	.vbtn.on {
		background: var(--accent);
		color: #fff;
	}
	.boardcol {
		min-width: 0;
	}
	.multiboard {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		align-items: start;
	}
	.dayblock {
		padding-top: 0.4rem;
	}
	.dayblockhead {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.4rem 0 0.2rem 56px;
	}
	.dayblocklink {
		font-family: var(--serif);
		font-size: 1rem;
		color: var(--ink);
		text-decoration: none;
	}
	.dayblocklink:hover {
		color: var(--accent-ink);
	}
	.agenda {
		padding: 1.2rem 1.4rem;
		display: flex;
		flex-direction: column;
		gap: 1.4rem;
	}
	.agdayhead {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		margin-bottom: 0.5rem;
		border-bottom: 1px solid var(--line);
		padding-bottom: 0.4rem;
	}
	.agdayhead a {
		font-family: var(--serif);
		font-size: 1.1rem;
		color: var(--ink);
		text-decoration: none;
	}
	.agempty {
		margin: 0.2rem 0 0;
	}
	.agtrack {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0.7rem 0 0.3rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.agswatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
	}
	.aglist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.aglist li {
		display: flex;
		align-items: baseline;
		gap: 0.7rem;
		font-size: 0.92rem;
		padding: 0.25rem 0;
	}
	.agtime {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		color: var(--ink-soft);
		min-width: 6.5rem;
	}
	.agtitle {
		flex: 1;
		min-width: 0;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.agwho,
	.aglist li > .small,
	.aglist li > .tag {
		flex: 0 0 auto;
	}
	.tools {
		display: flex;
		gap: 0.6rem;
		flex: none;
		align-items: center;
	}
	.zone {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.82rem;
		color: var(--ink-soft);
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		white-space: nowrap;
	}
	.zdot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
	.addtrack {
		display: flex;
		gap: 0.6rem;
		padding: 0.8rem;
		margin-bottom: 1rem;
	}
	.addtrack input {
		flex: 1;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		font: inherit;
	}
	.schedule .mbody {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.templates {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.chip {
		font: inherit;
		font-size: 0.78rem;
		padding: 0.28rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink-soft);
		cursor: pointer;
	}
	.chip:hover {
		border-color: var(--accent);
		color: var(--accent-ink);
		background: var(--accent-soft);
	}
	.srow {
		display: flex;
		gap: 0.7rem;
		flex-wrap: wrap;
	}
	.schedule label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.schedule .grow {
		flex: 1 1 160px;
	}
	/* Track holds arbitrary user names, so let it take the slack; the time fields
	   hold short fixed-format values and don't need it. */
	.schedule .tf2 {
		width: 118px;
	}
	.schedule .tftrack {
		flex: 1 1 175px;
		min-width: 150px;
	}
	.schedule .tf3 {
		flex: 1 1 160px;
		min-width: 140px;
	}
	.tlabel {
		align-self: center;
		font-size: 0.8rem;
	}
	.viewas {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.vaicon {
		font-size: 0.9rem;
	}
	.lodgeband {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.7rem 56px;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		font-size: 0.85rem;
	}
	.lodgeband.locked {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.lodgeicon {
		font-size: 0.95rem;
	}
	.lodgename {
		font-weight: 600;
	}
	.lodgetag {
		font-size: 0.72rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--surface-2, #eef1ec);
		color: var(--ink-soft);
	}
	.lodgepick {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--accent-ink);
	}
	.lodgelink {
		margin-left: auto;
		font-size: 0.78rem;
		color: var(--accent-ink);
	}
	.bwho {
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.2rem;
		margin-top: 0.1rem;
		max-height: calc(var(--wrows, 2) * 15px);
		overflow: hidden;
	}
	.who {
		font-size: 0.62rem;
		line-height: 13px;
		padding: 0 0.35rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--c) 20%, white);
		color: var(--ink);
		white-space: nowrap;
	}
	.who.all {
		background: color-mix(in srgb, var(--c) 12%, white);
		color: var(--ink-soft);
		font-style: italic;
	}
	.who.more {
		background: transparent;
		border: 1px dashed color-mix(in srgb, var(--c) 45%, white);
		color: var(--ink-soft);
		cursor: help;
	}
	.aglodge {
		font-size: 0.8rem;
		color: var(--accent-ink);
	}
	.agwho {
		font-style: italic;
	}
	.schedule input {
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		font: inherit;
		background: var(--surface);
		color: var(--ink);
	}
	.sactions {
		display: flex;
		align-items: center;
		gap: 0.8rem;
	}
	.hint-inline {
		font-size: 0.8rem;
	}
	.split {
		display: grid;
		grid-template-columns: 1fr 440px;
		gap: 1rem;
		align-items: start;
	}
	.split.wide {
		grid-template-columns: 1fr;
	}
	.board {
		padding: 1rem 1rem 1rem 0;
		overflow: visible;
	}
	.empty {
		padding: 3rem 1.5rem;
		text-align: center;
	}
	.tracks {
		position: relative;
		padding-left: 56px;
	}
	.axis {
		position: absolute;
		left: 0;
		right: 0;
		top: 34px;
		bottom: 0;
	}
	.hourline {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid var(--line);
	}
	.hourline span {
		position: absolute;
		left: 0;
		top: -0.6rem;
		width: 48px;
		text-align: right;
		font-size: 0.72rem;
		color: var(--ink-faint);
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.lane {
		position: absolute;
		left: 56px;
		right: 0;
		top: 34px;
		bottom: 20px;
	}
	.lanemeasure {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	/* people-flow arrows between events */
	.flowlayer {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		overflow: visible;
		z-index: 12;
	}
	.hophalo {
		fill: none;
		stroke: var(--surface);
		stroke-width: 5;
		stroke-linecap: round;
		opacity: 0.95;
	}
	.hoppath {
		fill: none;
		stroke: #6f6455;
		stroke-width: 1.7;
		stroke-dasharray: 5 3;
		stroke-linecap: round;
	}
	.hopcount {
		font-size: 9.5px;
		font-weight: 700;
		fill: #5c5245;
		text-anchor: middle;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3.5px;
		stroke-linejoin: round;
	}
	.buffer {
		position: absolute;
		box-sizing: border-box;
		border-radius: var(--r-sm) var(--r-sm) 0 0;
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in srgb, var(--c) 14%, white),
			color-mix(in srgb, var(--c) 14%, white) 5px,
			transparent 5px,
			transparent 10px
		);
		border: 1px dashed color-mix(in srgb, var(--c) 45%, white);
		border-bottom: none;
		pointer-events: none;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.buffer span {
		font-size: 0.62rem;
		color: var(--ink-faint);
		white-space: nowrap;
	}
	.block {
		position: absolute;
		box-sizing: border-box;
		border-radius: var(--r-sm);
		border-left: 3px solid var(--c);
		background: color-mix(in srgb, var(--c) 10%, white);
		padding: 0.4rem 0.55rem;
		overflow: hidden;
		box-shadow: var(--shadow-sm);
		cursor: grab;
		touch-action: none;
		user-select: none;
		z-index: 6;
	}
	.block.narrow {
		padding: 0.3rem 0.35rem;
		font-size: 0.92em;
	}
	.block.dragging {
		cursor: grabbing;
		box-shadow: var(--shadow);
		z-index: 20;
		opacity: 0.95;
	}
	.block.resizing {
		box-shadow: var(--shadow);
		z-index: 20;
	}
	.block.editingnow {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
		z-index: 8;
	}
	.bresize {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 8px;
		cursor: ns-resize;
		touch-action: none;
	}
	.bresize::after {
		content: '';
		position: absolute;
		left: 50%;
		bottom: 2px;
		width: 22px;
		height: 3px;
		border-radius: 999px;
		transform: translateX(-50%);
		background: var(--c);
		opacity: 0;
	}
	.block:hover .bresize::after {
		opacity: 0.5;
	}
	.bdel {
		position: absolute;
		top: 2px;
		right: 3px;
		border: none;
		background: none;
		color: var(--ink-faint);
		font-size: 0.95rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.15rem;
		opacity: 0;
	}
	.block:hover .bdel {
		opacity: 1;
	}
	.bdel:hover {
		color: var(--danger, #b4462a);
	}
	.block.freetime {
		background: repeating-linear-gradient(45deg, #f3f2ec, #f3f2ec 6px, #eceae2 6px, #eceae2 12px);
		border-left-color: var(--ink-faint);
	}
	.block.unbooked {
		border-left-style: dashed;
	}
	.bt {
		font-size: 0.85rem;
		font-weight: 500;
		line-height: 15px;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: var(--trows, 3);
		line-clamp: var(--trows, 3);
		overflow: hidden;
	}
	.bmeta {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.05rem;
		height: 16px;
		font-size: 0.72rem;
		color: var(--ink-faint);
	}
	.bmeta > span {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.tag {
		flex: 0 0 auto;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		font-size: 0.66rem;
		font-weight: 600;
		border: none;
		cursor: pointer;
		font-family: inherit;
	}
	.tag.booked {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	.tag.tentative {
		background: #eef1f0;
		color: var(--ink-soft);
	}
	.tag.unbooked {
		background: var(--warn-soft);
		color: var(--warn);
	}
	.mapwrap {
		padding: 0;
		overflow: hidden;
		position: sticky;
		top: 80px;
	}
	.legs {
		padding: 1rem 1.1rem 1.2rem;
	}
	.maplegend {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.6rem;
	}
	.dotmark {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #9aa39c;
		border: 2px solid #fff;
		box-shadow: 0 0 0 1px var(--line);
		display: inline-block;
	}
	.legs h4 {
		margin: 0 0 0.6rem;
		font-size: 0.9rem;
	}
	.legs ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.legs li {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.85rem;
	}
	.warn-leg > span:last-child {
		color: var(--warn);
	}
	.small {
		font-size: 0.85rem;
	}
	.hint {
		font-size: 0.78rem;
		margin: 1rem 0 0;
		border-top: 1px solid var(--line);
		padding-top: 0.8rem;
	}
	@media (max-width: 900px) {
		.split {
			grid-template-columns: 1fr;
		}
		.mapwrap {
			position: static;
		}
	}

	/* Crews modal */
	/* Crew split / rejoin summary + guide-lines (Day view) */
	.switchbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.8rem;
	}
	.switchcap {
		font-weight: 600;
		margin-right: 0.1rem;
	}
	.switchpill {
		font-size: 0.72rem;
		padding: 0.18rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink-soft);
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.switchpill .swico {
		font-weight: 700;
	}
	.switchpill.split {
		border-color: color-mix(in srgb, #b4682a 55%, white);
		background: color-mix(in srgb, #b4682a 12%, white);
		color: #8a4d1e;
	}
	.switchpill.rejoin {
		border-color: color-mix(in srgb, #2f6d5e 55%, white);
		background: color-mix(in srgb, #2f6d5e 12%, white);
		color: #235448;
	}
	.switchpill.move {
		border-color: color-mix(in srgb, #4a6d8c 55%, white);
		background: color-mix(in srgb, #4a6d8c 12%, white);
		color: #365064;
	}
	/* split / rejoin guide-lines drawn across the day's tracks */
	.switchline {
		position: absolute;
		left: 56px;
		right: 0;
		border-top: 2.5px dashed color-mix(in srgb, #4a6d8c 35%, white);
		pointer-events: none;
		z-index: 3;
	}
	.switchline.split {
		border-top-color: color-mix(in srgb, #b4682a 45%, white);
	}
	.switchline.rejoin {
		border-top-color: color-mix(in srgb, #2f6d5e 45%, white);
	}
	.switchtag {
		position: absolute;
		left: 0;
		top: -0.68rem;
		transform: translateX(-4px);
		font-size: 0.64rem;
		font-weight: 700;
		padding: 0.08rem 0.4rem;
		border-radius: 999px;
		background: var(--surface);
		border: 1px solid var(--line);
		color: var(--ink-soft);
		white-space: nowrap;
		box-shadow: var(--shadow-sm);
	}
	.switchline.split .switchtag {
		color: #8a4d1e;
		border-color: color-mix(in srgb, #b4682a 40%, white);
	}
	.switchline.rejoin .switchtag {
		color: #235448;
		border-color: color-mix(in srgb, #2f6d5e 40%, white);
	}
	/* live "now" line */
	.nowline {
		position: absolute;
		left: 56px;
		right: 0;
		border-top: 2px solid #c2453b;
		pointer-events: none;
		z-index: 5;
	}
	.nowline::before {
		content: '';
		position: absolute;
		left: -4px;
		top: -4px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #c2453b;
	}
	.nowtag {
		position: absolute;
		right: 2px;
		top: -0.62rem;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		padding: 0.06rem 0.34rem;
		border-radius: 999px;
		background: #c2453b;
		color: #fff;
		white-space: nowrap;
	}
	/* event detail popup */
	.dfacts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2, #fbfaf7);
	}
	.dfact {
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	/* ── People swimlane: rows = people, x = time ─────────────────────────── */
	.swim {
		padding: 1.3rem 0.2rem 0.2rem;
	}
	.swimhead,
	.swimrow {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.swimrow {
		height: 40px;
	}
	.swimname {
		width: 74px;
		flex-shrink: 0;
		text-align: right;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--ink-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.swimaxis {
		position: relative;
		flex: 1;
		height: 18px;
	}
	.swimhour {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		font-size: 0.68rem;
		color: var(--ink-faint);
		white-space: nowrap;
	}
	.swimtrack {
		position: relative;
		flex: 1;
		height: 30px;
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--line) 22%, white);
		overflow: hidden;
	}
	.swimgrid {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: color-mix(in srgb, var(--line) 55%, white);
	}
	.swimfree {
		position: absolute;
		top: 0;
		bottom: 0;
		background: repeating-linear-gradient(
			-45deg,
			transparent,
			transparent 4px,
			color-mix(in srgb, var(--line) 40%, white) 4px,
			color-mix(in srgb, var(--line) 40%, white) 8px
		);
	}
	.swimband {
		position: absolute;
		top: 2px;
		bottom: 2px;
		border: none;
		border-left: 3px solid var(--c);
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--c) 26%, white);
		padding: 0 0.35rem;
		font: inherit;
		font-size: 0.7rem;
		color: var(--ink);
		text-align: left;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	.swimband:hover {
		background: color-mix(in srgb, var(--c) 38%, white);
	}
	.swimband.travel,
	.swimband.transport {
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in srgb, var(--c) 22%, white),
			color-mix(in srgb, var(--c) 22%, white) 5px,
			color-mix(in srgb, var(--c) 10%, white) 5px,
			color-mix(in srgb, var(--c) 10%, white) 10px
		);
	}
	.swimlabel {
		pointer-events: none;
	}
	.swimswitch {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 0;
		border-left: 2px dashed color-mix(in srgb, #4a6d8c 60%, white);
	}
	.swimswtag {
		position: absolute;
		top: -1.05rem;
		left: 0;
		transform: translateX(-50%);
		font-size: 0.62rem;
		font-weight: 700;
		padding: 0.04rem 0.3rem;
		border-radius: 999px;
		background: var(--surface);
		border: 1px solid var(--line);
		color: var(--ink-soft);
		white-space: nowrap;
	}
	.swimswitch.split {
		border-left-color: color-mix(in srgb, #b4682a 70%, white);
	}
	.swimswitch.split .swimswtag {
		color: #8a4d1e;
		border-color: color-mix(in srgb, #b4682a 45%, white);
	}
	.swimswitch.rejoin {
		border-left-color: color-mix(in srgb, #2f6d5e 70%, white);
	}
	.swimswitch.rejoin .swimswtag {
		color: #235448;
		border-color: color-mix(in srgb, #2f6d5e 45%, white);
	}
	.swimnow {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 0;
		border-left: 2px solid #c2453b;
	}
	.swimbody {
		position: relative;
	}
	/* guide-lines float above every row so a split reads as one moment */
	.swimlines {
		position: absolute;
		left: 80px;
		right: 0;
		top: 0;
		bottom: 0;
		pointer-events: none;
		z-index: 5;
	}
	.swimhint {
		margin: 0.7rem 0 0.2rem 80px;
	}
	.crewbody {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.crewintro {
		margin: 0;
	}
	.crewnew {
		display: flex;
		gap: 0.5rem;
		padding-bottom: 0.8rem;
		border-bottom: 1px solid var(--line);
	}
	.crewnew input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		font: inherit;
	}
	.crewcard {
		margin: 0;
		padding: 0.7rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}
	.crewhd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.crewrename {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex: 1;
	}
	.crewrename input:not([type]) {
		flex: 1;
		min-width: 6rem;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		font: inherit;
	}
	.crewrename input[type='color'] {
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: none;
		cursor: pointer;
	}
	.crewday {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}
	.crewday :global(.select) {
		min-width: 150px;
	}
	.crewmem {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.6rem;
	}
	.memchip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.15rem 0.2rem 0.15rem 0.55rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-ink);
		font-size: 0.8rem;
	}
	.memchip .rejoin {
		border: none;
		background: none;
		cursor: pointer;
		color: inherit;
		opacity: 0.7;
		font-size: 0.9rem;
		line-height: 1;
		padding: 0 0.2rem;
	}
	.memchip .rejoin:hover {
		opacity: 1;
	}
	.memchip form {
		display: inline;
	}
	.splitform {
		margin: 0;
		padding: 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-alt, #faf9f5);
	}
	.splithd {
		margin-bottom: 0.5rem;
	}
	.splitgrid {
		display: grid;
		grid-template-columns: 1.4fr 1fr 0.9fr;
		gap: 0.6rem;
		margin-bottom: 0.7rem;
	}
	.splitgrid label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	@media (max-width: 620px) {
		.splitgrid {
			grid-template-columns: 1fr;
		}
	}
</style>
