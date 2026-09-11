import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { useTrip } from './TripShell';
import FormError from '../components/ui/FormError';
import EmptyState from '../components/ui/EmptyState';
import MultiSelect from '../components/ui/MultiSelect';
import GoogleMap, { type MapTrack } from '../components/GoogleMap';
import TripMap from '../components/TripMap';
import { localDayMinutes, localTime, zoneAbbr } from '@trippy/core/tz';
import { layoutDay, personBands } from '@trippy/core/layout';
import { layoutLegs } from '@trippy/core/travel';
import { copy } from '../copy';
import AddEventDialog from './schedule/AddEventDialog';
import EventDialog from './schedule/EventDialog';
import TravelDialog from './schedule/TravelDialog';
import CrewsDialog from './schedule/CrewsDialog';
import {
	DAY_END,
	DAY_START,
	HOURS,
	PX_PER_MIN,
	blockSpan,
	dayLabel,
	heightPx,
	hhmm,
	modeLabel,
	pctLeft,
	pctWidth,
	shiftDay,
	topPx,
	whoBudget
} from './schedule/shared';
import type { BoardDay, EventRow, LegRow, Member, ScheduleData, ViewMode } from './schedule/types';
import '../styles/schedule.css';

const VIEW_OPTIONS: { v: ViewMode; label: string }[] = [
	{ v: 'day', label: 'Day' },
	{ v: '3day', label: '3-day' },
	{ v: 'people', label: 'People' }
];

/** One drawn block: an event, and whether this is a stay's next-morning tail. */
type Block = { ev: EventRow; tail: boolean };

/** Blocks are keyed per drawing, since a stay is drawn on two days. */
function blockKey(b: Block): string {
	return b.tail ? `${b.ev.id}:tail` : b.ev.id;
}

export default function Schedule() {
	const { trip } = useTrip();
	const base = `/trips/${trip.id}/schedule`;

	// Read-only: every day and view change is a <Link>, so the board stays
	// addressable and the back button walks back through the days.
	const [params] = useSearchParams();
	const dayParam = params.get('day');
	const viewParam = params.get('view');
	const query = new URLSearchParams();
	if (dayParam) query.set('day', dayParam);
	if (viewParam) query.set('view', viewParam);
	const qs = query.toString();

	const { data, error, reload } = useApi<ScheduleData>(qs ? `${base}?${qs}` : base);
	// The payload carries the events, the crews that fill their people picker,
	// the stays behind the lodging band and the roster it is filtered by.
	useLiveSection(['schedule', 'lodging', 'members', 'trip'], reload);

	/**
	 * Who the board is being read for. Null is everybody, which is the default
	 * and stays the default as people join the trip: holding the roster in state
	 * would pin the filter to whoever was a member when the page loaded.
	 */
	const [viewAs, setViewAs] = useState<string[] | null>(null);
	const [adding, setAdding] = useState(false);
	const [crewsOpen, setCrewsOpen] = useState(false);
	const [openEventKey, setOpenEventKey] = useState('');
	const [openLegId, setOpenLegId] = useState('');
	const [notice, setNotice] = useState('');

	// Live drag and resize of a single block.
	const [drag, setDrag] = useState<{
		id: string;
		day: string;
		pointerStartY: number;
		origStart: number;
		liveStart: number;
	} | null>(null);
	const [resize, setResize] = useState<{
		id: string;
		pointerStartY: number;
		startMin: number;
		origEnd: number;
		liveEnd: number;
	} | null>(null);
	/* Where a block was let go, held until the reloaded day agrees.
	 *
	 * Clearing the drag on pointer-up is not enough on its own: the write is a
	 * round trip, so for the length of it the block would render at the position
	 * it started from and then jump forward when the new day arrived. Without a
	 * transition that read as a flicker; with one it reads as a rubber band,
	 * which is worse. The override bridges exactly that gap and is dropped the
	 * moment a fresh payload lands, whatever that payload says, so a value the
	 * server clamps or refuses still wins. */
	const [pending, setPending] = useState<{ id: string; start?: number; end?: number } | null>(null);
	useEffect(() => {
		setPending(null);
	}, [data]);
	/* Set while a pointer drag actually moves, so the click that follows a drag
	   does not also open the event. A ref, not state: it is read during the same
	   event sequence that writes it and must never lag a render behind. */
	const didDrag = useRef(false);

	// Measured width of the day view's event area, for fitting text into blocks.
	const [laneW, setLaneW] = useState(0);
	const laneRef = useCallback((node: HTMLDivElement | null) => {
		if (!node) return;
		setLaneW(node.clientWidth);
		const ro = new ResizeObserver(() => setLaneW(node.clientWidth));
		ro.observe(node);
		return () => ro.disconnect();
	}, []);

	// Live clock, for the "now" line in the destination's zone.
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(id);
	}, []);

	async function act(fn: () => Promise<unknown>) {
		setNotice('');
		try {
			await fn();
			reload();
		} catch (err) {
			setPending(null);
			setNotice(err instanceof ApiError ? err.message : copy.api.saveFallback);
		}
	}

	const eventOp = useCallback(
		(eventId: string, body: Record<string, unknown>) =>
			api(`${base}/events/${eventId}/op`, { method: 'POST', body }),
		[base]
	);

	const members: Member[] = useMemo(() => data?.members ?? [], [data]);
	const memberIds = useMemo(() => members.map((m) => m.id), [members]);
	const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
	const memberOptions = useMemo(
		() => members.map((m) => ({ value: m.id, label: m.name })),
		[members]
	);
	/** First name only: chips and journey labels get cramped fast. */
	const shortName = useCallback(
		(id: string) => (memberName.get(id) ?? '?').split(' ')[0],
		[memberName]
	);

	const selected = useMemo(() => {
		const roster = new Set(memberIds);
		return new Set(viewAs ? viewAs.filter((id) => roster.has(id)) : memberIds);
	}, [viewAs, memberIds]);

	/**
	 * The board with "view as" applied.
	 *
	 * An event with nobody on it belongs to the whole group and is always shown;
	 * otherwise one selected attendee is enough, because the question the filter
	 * answers is "what does this day look like for these people", and an event
	 * half of them are at is part of it.
	 */
	const board: BoardDay[] = useMemo(() => {
		const showEvent = (e: EventRow) =>
			e.people.length === 0 || e.people.some((p) => selected.has(p));
		const showLeg = (l: LegRow) => l.people.some((p) => selected.has(p));
		return (data?.board ?? []).map((entry) => ({
			...entry,
			events: entry.events.filter(showEvent),
			incoming: entry.incoming && showEvent(entry.incoming) ? entry.incoming : null,
			legs: entry.legs.filter(showLeg)
		}));
	}, [data, selected]);

	const anchor = useMemo(
		() => (data ? (board.find((b) => b.day === data.day) ?? board[0] ?? null) : null),
		[board, data]
	);
	const anchorCity = anchor?.city ?? null;

	/** Every event on the board, for looking one up by id from a dialog. */
	const eventById = useMemo(() => {
		const out = new Map<string, EventRow>();
		for (const entry of board) {
			for (const e of entry.events) out.set(e.id, e);
			if (entry.incoming) out.set(entry.incoming.id, entry.incoming);
		}
		return out;
	}, [board]);

	const legById = useMemo(() => {
		const out = new Map<string, LegRow>();
		for (const entry of board) for (const l of entry.legs) out.set(l.id, l);
		return out;
	}, [board]);

	const openEvent = openEventKey ? (eventById.get(openEventKey.split(':')[0]) ?? null) : null;
	const openLeg = openLegId ? (legById.get(openLegId) ?? null) : null;

	const peopleLabel = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return 'Everyone';
			if (ids.length === members.length) return 'Everyone';
			return ids.map((id) => shortName(id)).join(', ');
		},
		[members.length, shortName]
	);

	// --- Drag and resize ----------------------------------------------------

	function startFor(ev: EventRow): number {
		if (drag && drag.id === ev.id) return drag.liveStart;
		if (pending && pending.id === ev.id && pending.start !== undefined) return pending.start;
		return ev.start_min;
	}
	function endFor(ev: EventRow): number {
		if (resize && resize.id === ev.id) return resize.liveEnd;
		if (pending && pending.id === ev.id && pending.end !== undefined) return pending.end;
		return startFor(ev) + (ev.end_min - ev.start_min);
	}

	function onPointerDown(e: React.PointerEvent, ev: EventRow, day: string) {
		// Let the resize grip through.
		if ((e.target as HTMLElement).closest('.bresize')) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag.current = false;
		setDrag({
			id: ev.id,
			day,
			pointerStartY: e.clientY,
			origStart: ev.start_min,
			liveStart: ev.start_min
		});
	}

	function onPointerMove(e: React.PointerEvent) {
		if (!drag) return;
		const y = e.clientY;
		if (Math.abs(y - drag.pointerStartY) > 3) didDrag.current = true;
		setDrag((d) =>
			d
				? // Snap the live position to 5-minute steps so the label never shows
					// decimals while dragging.
					{
						...d,
						liveStart: Math.round((d.origStart + (y - d.pointerStartY) / PX_PER_MIN) / 5) * 5
					}
				: d
		);
	}

	async function onPointerUp() {
		if (!drag) return;
		const snapped = Math.round(drag.liveStart / 5) * 5;
		const { id, origStart, day } = drag;
		setDrag(null);
		if (snapped !== origStart) {
			setPending({ id, start: snapped });
			// The day rides along because a move carries one, and sending the block's
			// own day keeps a drag in the 3-day view on the column it was drawn in.
			await act(() => eventOp(id, { op: 'move', startMin: snapped, day }));
		}
	}

	function onResizeDown(e: React.PointerEvent, ev: EventRow) {
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag.current = false;
		setResize({
			id: ev.id,
			pointerStartY: e.clientY,
			startMin: ev.start_min,
			origEnd: ev.end_min,
			liveEnd: ev.end_min
		});
	}

	function onResizeMove(e: React.PointerEvent) {
		if (!resize) return;
		const y = e.clientY;
		if (Math.abs(y - resize.pointerStartY) > 3) didDrag.current = true;
		setResize((r) =>
			r
				? {
						...r,
						liveEnd: Math.max(
							r.startMin + 15,
							Math.round((r.origEnd + (y - r.pointerStartY) / PX_PER_MIN) / 5) * 5
						)
					}
				: r
		);
	}

	async function onResizeUp() {
		if (!resize) return;
		const snapped = Math.round(resize.liveEnd / 5) * 5;
		const { id, origEnd } = resize;
		setResize(null);
		if (snapped !== origEnd) {
			setPending({ id, end: snapped });
			await act(() => eventOp(id, { op: 'resize', endMin: snapped }));
		}
	}

	/**
	 * Minutes since midnight for the "now" line on `day`, or null when that day
	 * is not today in the destination's zone. Never the browser's zone: the
	 * schedule is written in the city's local time and the line has to agree
	 * with the blocks around it.
	 */
	function nowLineFor(day: string, tz: string | null | undefined): number | null {
		if (!tz) return null;
		const local = localDayMinutes(tz, now);
		if (local.day !== day) return null;
		if (local.minutes < DAY_START || local.minutes > DAY_END) return null;
		return local.minutes;
	}

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	const view = data.view;
	const wide = view !== 'day';
	const navUrl = (day: string, v: string) => `?day=${day}&view=${v}`;

	// --- Board pieces -------------------------------------------------------

	function lodgingBand(entry: BoardDay) {
		if (!entry.lodging) return null;
		const l = entry.lodging;
		return (
			<div className={l.locked ? 'lodgeband locked' : 'lodgeband'}>
				<span className="lodgename">{l.name}</span>
				{l.tag && <span className="lodgetag">{l.tag}</span>}
				{l.url && (
					<a className="lodgelink" href={l.url} target="_blank" rel="noopener">
						Details
					</a>
				)}
			</div>
		);
	}

	function blockNode(b: Block, day: string, lanePx: number, place: ReturnType<typeof layoutDay>) {
		const { ev, tail } = b;
		const p = place.placed.get(blockKey(b));
		if (!p) return null;

		const span = blockSpan(ev, tail);
		// A tail is last night's stay reaching into this morning, so it is not the
		// row's own position and cannot be dragged from here: the check-in it
		// would move belongs to the previous day. A stay's own block always runs
		// to midnight, because its end is a time on the day after this one.
		const from = tail ? span.from : startFor(ev);
		const to = tail ? span.to : ev.type === 'stay' ? DAY_END : endFor(ev);
		const box = { left: `${p.left * 100}%`, width: `calc(${p.width * 100}% - 6px)` };
		const bud = whoBudget(p.width, to - from, ev.title, lanePx);
		const cls = [
			'block',
			ev.type,
			tail ? 'tail' : '',
			drag?.id === ev.id && !tail ? 'dragging' : '',
			resize?.id === ev.id && !tail ? 'resizing' : '',
			openEventKey === blockKey(b) ? 'editingnow' : '',
			p.width < 0.34 ? 'narrow' : ''
		]
			.filter(Boolean)
			.join(' ');

		return (
			<div
				key={blockKey(b)}
				className={cls}
				role="button"
				tabIndex={0}
				aria-label={`${ev.title}, ${hhmm(ev.start_min)} to ${hhmm(ev.end_min)}. Open, or drag to reschedule.`}
				style={{
					...box,
					top: `${topPx(from)}px`,
					height: `${heightPx(from, to)}px`,
					['--trows' as string]: bud.trows,
					['--wrows' as string]: bud.wrows
				}}
				onPointerDown={tail ? undefined : (e) => onPointerDown(e, ev, day)}
				onPointerMove={tail ? undefined : onPointerMove}
				onPointerUp={tail ? undefined : onPointerUp}
				onClick={(e) => {
					if ((e.target as HTMLElement).closest('.bresize')) return;
					if (didDrag.current) return;
					setOpenEventKey(blockKey(b));
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						setOpenEventKey(blockKey(b));
					}
				}}
			>
				<div className="bt">
					{ev.title}
					{tail && <span className="muted"> checkout</span>}
				</div>
				<div className="bmeta">
					{bud.showTime && (
						<span>
							{bud.compact
								? hhmm(ev.start_min)
								: `${hhmm(ev.type === 'stay' ? ev.start_min : from)}-${hhmm(ev.type === 'stay' ? ev.end_min : to)}`}
						</span>
					)}
				</div>
				<div className="bwho">
					{ev.people.length === 0 || ev.people.length === members.length ? (
						<span className="who all">Everyone</span>
					) : ev.people.length <= bud.fit ? (
						ev.people.map((id) => (
							<span key={id} className="who">
								{shortName(id)}
							</span>
						))
					) : bud.fit > 0 ? (
						<>
							{ev.people.slice(0, bud.fit - 1).map((id) => (
								<span key={id} className="who">
									{shortName(id)}
								</span>
							))}
							<span className="who more" title={ev.people.map((id) => shortName(id)).join(', ')}>
								+{ev.people.length - (bud.fit - 1)}
							</span>
						</>
					) : null}
				</div>
				{/* A stay's end is a checkout on the following morning, so dragging
				    this day's bottom edge would not mean anything. Its times are
				    changed in the dialog instead. */}
				{!tail && ev.type !== 'stay' && (
					<div
						className="bresize"
						role="separator"
						aria-label="Drag to change the end time"
						onPointerDown={(e) => onResizeDown(e, ev)}
						onPointerMove={onResizeMove}
						onPointerUp={onResizeUp}
					/>
				)}
			</div>
		);
	}

	function legNodes(entry: BoardDay) {
		const { blocks, arrows } = layoutLegs(entry.legs);
		return (
			<>
				{blocks.map(({ leg, lane, lanes }) => (
					<button
						key={leg.key}
						type="button"
						className={['legblock', leg.tight ? 'tight' : '', leg.manual ? 'manual' : '']
							.filter(Boolean)
							.join(' ')}
						style={{
							top: `${topPx(leg.startMin)}px`,
							height: `${heightPx(leg.startMin, leg.endMin)}px`,
							left: `${(lane / lanes) * 100}%`,
							width: `calc(${100 / lanes}% - 3px)`
						}}
						title={legTitle(leg)}
						onClick={() => setOpenLegId(leg.id)}
					>
						<span className="legmode">{modeLabel(leg.resolvedMode)}</span>
						<span className="legmins">{leg.resolvedMins}m</span>
					</button>
				))}
				{/* A cluster too dense to draw collapses into one arrow. Clicking it
				    opens the first of its journeys; the rest are in the list beside
				    the map, which is the one place every journey is reachable. */}
				{arrows.map((a) => {
					const first = entry.legs.find((l) => l.key === a.keys[0]);
					return (
						<button
							key={a.keys.join('|')}
							type="button"
							className="legarrow"
							style={{ top: `${topPx(a.startMin)}px` }}
							title={`${a.keys.length} journeys, ${peopleLabel(a.people)}`}
							onClick={() => first && setOpenLegId(first.id)}
						>
							{a.keys.length}
						</button>
					);
				})}
			</>
		);
	}

	function legTitle(leg: LegRow): string {
		const from = eventById.get(leg.fromEventId)?.title ?? '?';
		const to = eventById.get(leg.toEventId)?.title ?? '?';
		const tail = leg.tight ? ', does not fit the gap' : leg.manual ? ', pinned' : '';
		return `${from} to ${to}: ${modeLabel(leg.resolvedMode)}, ${leg.resolvedMins}m${tail}\n${peopleLabel(leg.people)}`;
	}

	function dayBoard(entry: BoardDay, opts: { lanePx: number; measure?: boolean }) {
		const blocks: Block[] = [
			...entry.events.map((ev) => ({ ev, tail: false })),
			...(entry.incoming ? [{ ev: entry.incoming, tail: true }] : [])
		];

		if (blocks.length === 0 && entry.legs.length === 0) {
			return <EmptyState graphic message={copy.common.nothingAdded} />;
		}

		const place = layoutDay(
			blocks.map((b) => {
				const span = blockSpan(b.ev, b.tail);
				return {
					id: blockKey(b),
					start: span.from,
					end: span.to,
					// An event with nobody on it is the whole group, and saying so here
					// is what keeps it from being ranked as a lane of its own.
					people: b.ev.people.length ? b.ev.people : memberIds
				};
			})
		);
		const nowMin = nowLineFor(entry.day, entry.city?.tz);

		return (
			<div className="grid" style={{ height: `${(DAY_END - DAY_START) * PX_PER_MIN + 16}px` }}>
				<div className="axis">
					{HOURS.map((h) => (
						<div
							key={h}
							className="hourline"
							style={{ top: `${(h * 60 - DAY_START) * PX_PER_MIN}px` }}
						>
							<span>{h}:00</span>
						</div>
					))}
				</div>

				{nowMin !== null && (
					<div className="nowline" style={{ top: `${topPx(nowMin)}px` }}>
						<span className="nowtag">{hhmm(nowMin)}</span>
					</div>
				)}

				<div className="lane" ref={opts.measure ? laneRef : undefined}>
					{blocks.map((b) => blockNode(b, entry.day, opts.lanePx, place))}
				</div>

				{/* Journeys get their own lane rather than sharing the event columns:
				    they are the consequence of the day rather than part of it, and a
				    travel block between two events would make the gap look booked. */}
				<div className="travellane">{legNodes(entry)}</div>
			</div>
		);
	}

	function peopleBoard(entry: BoardDay) {
		const blocks: Block[] = [
			...entry.events.map((ev) => ({ ev, tail: false })),
			...(entry.incoming ? [{ ev: entry.incoming, tail: true }] : [])
		];
		if (blocks.length === 0) return <EmptyState graphic message={copy.common.nothingAdded} />;

		const rows = members.filter((m) => selected.has(m.id));
		const bands = personBands(
			blocks.map((b) => {
				const span = blockSpan(b.ev, b.tail);
				return {
					id: blockKey(b),
					start: span.from,
					end: span.to,
					people: b.ev.people.length ? b.ev.people : memberIds
				};
			}),
			rows.map((m) => m.id),
			DAY_START,
			DAY_END
		);
		const byKey = new Map(blocks.map((b) => [blockKey(b), b]));
		const nowMin = nowLineFor(entry.day, entry.city?.tz);

		return (
			<div className="swim">
				<div className="swimhead">
					<span className="swimname" />
					<div className="swimaxis">
						{HOURS.filter((h) => h % 2 === 0).map((h) => (
							<span key={h} className="swimhour" style={{ left: `${pctLeft(h * 60)}%` }}>
								{h}:00
							</span>
						))}
					</div>
				</div>

				<div className="swimbody">
					{nowMin !== null && (
						<div className="swimlines">
							<span className="swimnow" style={{ left: `${pctLeft(nowMin)}%` }} />
						</div>
					)}

					{rows.map((person) => (
						<div key={person.id} className="swimrow">
							<span className="swimname" title={memberName.get(person.id)}>
								{shortName(person.id)}
							</span>
							<div className="swimtrack">
								{HOURS.map((h) => (
									<span key={h} className="swimgrid" style={{ left: `${pctLeft(h * 60)}%` }} />
								))}
								{(bands.get(person.id) ?? []).map((band) => {
									const b = band.eventId ? byKey.get(band.eventId) : null;
									const pos = {
										left: `${pctLeft(band.start)}%`,
										width: `${pctWidth(band.start, band.end)}%`
									};
									if (!b) {
										return (
											<span
												key={`free-${band.start}`}
												className="swimfree"
												style={pos}
												title={`Free ${hhmm(band.start)} to ${hhmm(band.end)}`}
											/>
										);
									}
									return (
										<button
											key={blockKey(b)}
											type="button"
											className={`swimband ${b.ev.type}`}
											style={pos}
											title={`${b.ev.title}, ${hhmm(band.start)} to ${hhmm(band.end)}\n${peopleLabel(b.ev.people)}`}
											onClick={() => setOpenEventKey(blockKey(b))}
										>
											<span className="swimlabel">{b.ev.title}</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	// --- Map ----------------------------------------------------------------

	const cityPins = data.cities.filter((c) => c !== null);
	const mapTracks: MapTrack[] = [];
	if (cityPins.length) {
		mapTracks.push({
			name: 'Cities',
			color: '#9aa39c',
			items: cityPins.map((c) => ({ title: c.name, lat: c.lat, lng: c.lng })),
			line: false,
			dot: true
		});
	}
	const dayPins = (anchor?.events ?? []).filter((e) => e.lat != null && e.lng != null);
	if (dayPins.length) {
		mapTracks.push({
			name: dayLabel(data.day),
			color: '#2f6d5e',
			items: dayPins.map((e) => ({ title: e.title, lat: e.lat, lng: e.lng }))
		});
	}

	return (
		<div className="sched">
			<div className="toolbar">
				<div className="navgroup">
					<div className="daynav">
						<Link
							className="navbtn"
							to={navUrl(shiftDay(data.day, -1), view)}
							aria-label="Previous day"
						>
							‹
						</Link>
						<span className="curday">{dayLabel(data.day)}</span>
						<Link className="navbtn" to={navUrl(shiftDay(data.day, 1), view)} aria-label="Next day">
							›
						</Link>
					</div>
					<div className="viewswitch">
						{VIEW_OPTIONS.map((o) => (
							<Link
								key={o.v}
								className={o.v === view ? 'vbtn on' : 'vbtn'}
								to={navUrl(data.day, o.v)}
							>
								{o.label}
							</Link>
						))}
					</div>
				</div>

				<div className="tools">
					{anchorCity && (
						<span className="zone" title={`Times are ${anchorCity.name} local time`}>
							<span className="zdot" />
							{anchorCity.name} {localTime(anchorCity.tz, now)} {zoneAbbr(anchorCity.tz, now)}
						</span>
					)}
					<div className="viewas">
						<span className="muted">{copy.viewAs.label}</span>
						<MultiSelect
							selected={[...selected]}
							onChange={setViewAs}
							options={memberOptions}
							placeholder={copy.viewAs.everyone}
							ariaLabel="View the schedule as"
							compact
						/>
					</div>
					<button className="btn" type="button" onClick={() => setCrewsOpen(true)}>
						Crews
					</button>
					<button className="btn primary" type="button" onClick={() => setAdding(true)}>
						+ Add
					</button>
				</div>
			</div>

			{notice && (
				<p role="alert" className="mb-4 text-body text-danger-ink">
					{notice}
				</p>
			)}

			<div className={wide ? 'split wide' : 'split'}>
				<div className="boardcol">
					{view === 'people' ? (
						<div className="board card">
							{anchor && lodgingBand(anchor)}
							{anchor ? peopleBoard(anchor) : null}
						</div>
					) : view === 'day' ? (
						<div className="board card">
							{anchor && lodgingBand(anchor)}
							{anchor ? dayBoard(anchor, { lanePx: laneW || 560, measure: true }) : null}
						</div>
					) : (
						<div className="multiboard">
							{board.map((entry) => (
								<div key={entry.day} className="board card dayblock">
									<div className="dayblockhead">
										<Link className="dayblocklink" to={navUrl(entry.day, 'day')}>
											{dayLabel(entry.day)}
										</Link>
										{entry.city && <span className="muted">{entry.city.name}</span>}
									</div>
									{lodgingBand(entry)}
									{dayBoard(entry, { lanePx: 220 })}
								</div>
							))}
						</div>
					)}
				</div>

				{!wide && (
					<aside className="mapwrap card">
						{data.mapsKey ? (
							<GoogleMap tracks={mapTracks} apiKey={data.mapsKey} center={anchorCity} />
						) : (
							<TripMap tracks={mapTracks} />
						)}
						<div className="legs">
							<h4>Travel</h4>
							{anchor && anchor.legs.length ? (
								<ul>
									{anchor.legs.map((leg) => (
										<li key={leg.key}>
											<button
												type="button"
												className={leg.tight ? 'legrow tight' : 'legrow'}
												onClick={() => setOpenLegId(leg.id)}
											>
												<span className="legwhen">{hhmm(leg.startMin)}</span>
												<span className="legwhat">
													{eventById.get(leg.fromEventId)?.title ?? '?'} to{' '}
													{eventById.get(leg.toEventId)?.title ?? '?'}
												</span>
												<span className="legcost">
													{modeLabel(leg.resolvedMode)} {leg.resolvedMins}m
													{leg.manual && <span className="tag manual">pinned</span>}
												</span>
											</button>
										</li>
									))}
								</ul>
							) : (
								<EmptyState graphic message={copy.common.nothingAdded} />
							)}
						</div>
					</aside>
				)}
			</div>

			{adding && (
				<AddEventDialog
					base={base}
					day={data.day}
					defaults={data.defaults}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					onClose={() => setAdding(false)}
					onDone={() => {
						setAdding(false);
						reload();
					}}
				/>
			)}

			{openEvent && (
				<EventDialog
					key={openEvent.id}
					base={base}
					event={openEvent}
					cityName={anchorCity?.name ?? null}
					memberOptions={memberOptions}
					crews={data.crews}
					onClose={() => setOpenEventKey('')}
					onDone={() => {
						setOpenEventKey('');
						reload();
					}}
				/>
			)}

			{openLeg && (
				<TravelDialog
					key={openLeg.id}
					base={base}
					leg={openLeg}
					fromTitle={eventById.get(openLeg.fromEventId)?.title ?? '?'}
					toTitle={eventById.get(openLeg.toEventId)?.title ?? '?'}
					whoLabel={peopleLabel(openLeg.people)}
					onClose={() => setOpenLegId('')}
					onDone={() => {
						setOpenLegId('');
						reload();
					}}
				/>
			)}

			{crewsOpen && (
				<CrewsDialog
					base={base}
					crews={data.crews}
					memberOptions={memberOptions}
					onClose={() => setCrewsOpen(false)}
					onDone={reload}
				/>
			)}
		</div>
	);
}
