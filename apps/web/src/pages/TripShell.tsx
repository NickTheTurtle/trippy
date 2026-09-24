import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useTripEvents, TripEventsProvider } from '../hooks/useTripEvents';
import useMediaQuery from '../hooks/useMediaQuery';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { TABS } from '../nav';
import AddCityDialog from '../components/AddCityDialog';
import TripFormDialog from '../components/TripFormDialog';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { DeleteButton } from '../components/ui/useDeleteAction';
import { CheckBox } from '../components/ui/CheckBox';
import UiAvatar from '../components/ui/Avatar';
import Loading from '../components/ui/Loading';
import LoadError from '../components/ui/LoadError';
import { useToast } from '../components/ui/Toast';
import LiveOff from '../components/LiveOff';
import TabStrip from '../components/ui/TabStrip';
import { copy } from '../copy';

const c = copy.tripShell;

export type TripCity = {
	id: string;
	name: string;
	country: string;
	/**
	 * State / province, as `cities.region`. Null when the geocoder had none
	 * (Singapore, Monaco) or the row predates the column, so every reader has to
	 * cope with its absence rather than print an empty separator.
	 */
	region: string | null;
	tz: string;
	lat: number | null;
	lng: number | null;
};

export type Trip = {
	id: string;
	name: string;
	dates: string;
	cover: string;
	home_currency: string;
	start_date: string | null;
	end_date: string | null;
	role: string;
	/** 1 while the organizer has the schedule frozen. SQLite has no boolean. */
	schedule_locked: number;
	cities: TripCity[];
	members: string[];
};

type Ctx = {
	trip: Trip;
	reloadTrip: () => void;
	/**
	 * Opens the add-city dialog. The header does not offer this: cities are the
	 * axis of Discover, so that is the page it is reached from. The dialog still
	 * lives here because it changes the trip the shell owns and reloading it is
	 * the shell's call, but Discover is the only way in.
	 *
	 * The optional callback fires after each successful add, for a section
	 * holding its own copy of the cities that has to refetch alongside the trip.
	 */
	addCity: (onChanged?: () => void) => void;
};

/** Lets a section page read the trip the shell already loaded, rather than refetch it. */
export function useTrip(): Ctx {
	return useOutletContext<Ctx>();
}

export default function TripShell() {
	const { tripId } = useParams();
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const toast = useToast();
	const { data, error, errorStatus, reload } = useApi<{ trip: Trip }>(`/trips/${tripId}`);
	const [showEdit, setShowEdit] = useState(false);
	/**
	 * The open destructive confirmation, if any. Deleting is reached from the
	 * edit dialog, which closes to make way for it: nesting one modal inside
	 * another stacks two scroll locks and two Escape handlers for no gain.
	 * Cancelling puts the edit dialog back, so the trip is not left closed by a
	 * change of mind.
	 */
	const [confirming, setConfirming] = useState<'delete' | 'leave' | null>(null);
	const [showAddCity, setShowAddCity] = useState(false);
	/** Set by whoever opened the add-city dialog; see `Ctx.addCity`. */
	const onCityAdded = useRef<(() => void) | undefined>(undefined);

	// One live stream per open trip, owned here rather than by each section, so
	// moving between the tabs of a trip does not churn connections and switching
	// trips closes the old one before opening the new one.
	const events = useTripEvents(tripId ?? null);
	// Breakpoints the header reads to decide how many faces to show; see `faces`.
	const wideHeader = useMediaQuery('(min-width: 1024px)');
	const mediumHeader = useMediaQuery('(min-width: 640px)');
	const roomyHeader = useMediaQuery('(min-width: 400px)');

	// The header carries the name, the dates, the member avatars and the city
	// strip, so it follows all three of those topics. Subscribed through the
	// stable half of the stream, so a status change does not detach it.
	const { subscribe } = events.control;
	useEffect(() => subscribe(['trip', 'members', 'schedule'], reload), [subscribe, reload]);

	// `useApi` deliberately keeps the previous response while the next one is in
	// flight, which is what stops a reload blanking the page. Switching trips
	// goes through the same state, though, so the loaded trip has to be checked
	// against the one in the URL: without this the header, the tabs and every
	// section below render the trip you just left for as long as the fetch takes.
	const trip = data && data.trip.id === tripId ? data.trip : null;

	/* A trip that was readable and no longer is.
	 *
	 * `useApi` keeps the last good response through a failed reload, which is
	 * right for a blip and wrong for this: a member who has been removed, or
	 * whose trip the organizer deleted, went on looking at the whole trip, and
	 * every write they tried failed with no explanation. A 404 or 403 on a
	 * reload of a trip this tab had already loaded is not a blip, it is the
	 * answer, so it is said once and the tab goes back to the list. A first
	 * load that fails the same way is the "not found" page below instead: there
	 * is nothing on screen yet to take away. */
	const loadedFor = useRef<string | null>(null);
	if (trip) loadedFor.current = trip.id;
	const gone = errorStatus === 404 || errorStatus === 403;
	useEffect(() => {
		if (!gone || loadedFor.current !== tripId) return;
		loadedFor.current = null;
		toast.error(c.gone);
		navigate('/trips', { replace: true });
	}, [gone, tripId, toast, navigate]);

	// The tab showing, for the window title: "<Tab> - <Trip> - Trippy".
	const tab = TABS.find((t) => pathname.split('/')[3] === t.slug);
	useDocumentTitle(trip ? [tab?.label, trip.name] : [error ? c.notFound : undefined]);

	if (!trip) {
		// Still loading: say so rather than a blank band under the top bar.
		if (!error) {
			return (
				<main className="container py-8">
					<Loading />
				</main>
			);
		}
		// Only a trip the server says is not there (or not this caller's, which
		// it answers the same way) is "not found". Anything else, a 500 or a
		// dropped connection, is a failure that a second try may fix, and calling
		// it "not found" sent people back to the list for a trip that was fine.
		if (!gone) {
			return (
				<main className="container py-8">
					<LoadError message={error} onRetry={reload} />
				</main>
			);
		}
		return (
			<main className="container py-8">
				<p>
					{c.notFound}{' '}
					<Link to="/trips" className="text-accent-ink underline">
						{copy.common.allTrips}
					</Link>
				</p>
			</main>
		);
	}

	const base = `/trips/${trip.id}`;
	/* How many faces the strip shows before rolling the rest into one "+N".
	 *
	 * The strip is the trip at a glance, not the roster: the People tab holds
	 * that. So it gives up faces as the width tightens rather than holding a
	 * fixed 299px and squeezing the title into nothing. The count has to be
	 * computed rather than styled, since hiding faces in CSS would leave "+N"
	 * lying about how many were left out.
	 *
	 * Below 400px it gives up one more: the dates now share that row, and
	 * measured at 360px the third face is what pushes them onto a second
	 * line. */
	const faces = wideHeader ? 8 : mediumHeader ? 5 : roomyHeader ? 3 : 2;
	const extra = trip.members.length - faces;

	return (
		<TripEventsProvider value={events}>
			<div className="border-b border-line bg-surface">
				<div className="container">
					<Link
						to="/trips"
						className="tap inline-block pt-3 pb-1.5 text-body text-ink-faint hover:text-accent sm:pt-5 sm:pb-2.5"
					>
						{/* The arrow is drawn, not said: the link's name is the words. */}
						<span aria-hidden="true">← </span>
						{copy.common.allTrips}
					</Link>

					{/* Title, dates, roster: two rows on a phone and two columns above it.
					    Measured, the header band was 221px of a 390px screen and the
					    board below it was on its floor. The roster used to drop onto a
					    row of its own as soon as the title needed the width, which left
					    the dates on one line with nothing beside them and the faces on
					    the next with nothing beside them either: two rows to say what
					    fits on one. Below 640px the dates and the roster share the
					    second row, which is 37px of the day given back.

					    The grid replaces a `flex-wrap` with a 288px basis. The basis
					    existed to stop a shrinking title dragging the roster onto its
					    own line; a `minmax(0, 1fr)` column cannot do that in the first
					    place, and it keeps a long name wrapping inside its own column
					    rather than squeezing the faces. The title keeps its size at
					    every width: it is what says which trip this is, and a page
					    title shrunk to a section heading on the screen where the
					    context is smallest reads as a mistake. */}
					<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:items-start sm:gap-x-4 sm:gap-y-0">
						<h1 className="col-span-2 text-title [overflow-wrap:anywhere] sm:col-span-1">
							{trip.name}
						</h1>
						<p className="muted col-start-1">{trip.dates}</p>

						<div className="col-start-2 row-start-2 flex shrink-0 items-center justify-self-end sm:row-span-2 sm:row-start-1 sm:self-start">
							{trip.members.slice(0, faces).map((m, i) => (
								<Avatar key={`${m}-${i}`} title={m} label={m[0]} />
							))}
							{extra > 0 && (
								<Avatar title={trip.members.slice(faces).join(', ')} label={`+${extra}`} rest />
							)}
							{trip.role === 'organizer' ? (
								<button type="button" className="btn small ml-3" onClick={() => setShowEdit(true)}>
									{c.editTrip}
								</button>
							) : (
								<button
									type="button"
									className="btn small ml-3"
									onClick={() => setConfirming('leave')}
								>
									{c.leaveTrip}
								</button>
							)}
						</div>
					</div>

					<TabStrip base={base} tabs={TABS} />
				</div>
			</div>

			{showEdit && (
				<EditTrip
					trip={trip}
					onClose={() => setShowEdit(false)}
					onSaved={reload}
					onDelete={() => {
						setShowEdit(false);
						setConfirming('delete');
					}}
				/>
			)}
			<ConfirmDialog
				open={confirming !== null}
				title={
					confirming === 'leave'
						? c.leaveDialog.title(trip.name)
						: copy.common.deleteTitle(trip.name)
				}
				confirmLabel={confirming === 'leave' ? copy.common.leave : copy.common.delete}
				busyLabel={confirming === 'leave' ? copy.common.working : copy.common.deleting}
				onCancel={() => {
					const wasDelete = confirming === 'delete';
					setConfirming(null);
					if (wasDelete) setShowEdit(true);
				}}
				onConfirm={async () => {
					if (confirming === 'leave') {
						await api(`/trips/${trip.id}/leave`, { method: 'POST' });
					} else {
						await api(`/trips/${trip.id}`, { method: 'DELETE' });
					}
					// Either way this trip is no longer readable, and every section
					// below is mid-render against it. Leave before anything refetches.
					navigate('/trips', { replace: true });
				}}
			/>
			{showAddCity && (
				<AddCityDialog
					trip={trip}
					onClose={() => {
						setShowAddCity(false);
						onCityAdded.current = undefined;
					}}
					onChanged={() => {
						reload();
						// The section that opened the dialog usually has its own copy of
						// the cities. It is subscribed to the live `trip` event too, but
						// this must not be the only thing that refreshes it: the stream
						// drops, and an added city that appears in no list until a manual
						// reload reads as a failed add.
						onCityAdded.current?.();
					}}
				/>
			)}

			<main className="container py-8">
				<LiveOff />
				<div className="slidein">
					<Outlet
						context={
							{
								trip,
								reloadTrip: reload,
								addCity: (onChanged) => {
									onCityAdded.current = onChanged;
									setShowAddCity(true);
								}
							} satisfies Ctx
						}
					/>
				</div>
			</main>
		</TripEventsProvider>
	);
}

function Avatar({ title, label, rest }: { title: string; label: string; rest?: boolean }) {
	return (
		<UiAvatar
			title={title}
			label={label}
			tone={rest ? 'muted' : 'accent'}
			// Overlapped into a stack, and ringed in the page colour so the circles
			// read as separate discs rather than one blob.
			className={`-ml-1.5 border-2 border-surface ${rest ? 'cursor-help text-micro' : ''}`}
		/>
	);
}

/**
 * Edit. Same form as creating one, with the trip's own values in it; what is
 * local here is the PATCH, the `currency` spelling that endpoint takes, and
 * closing rather than navigating.
 */
function EditTrip({
	trip,
	onClose,
	onSaved,
	onDelete
}: {
	trip: Trip;
	onClose: () => void;
	onSaved: () => void;
	onDelete: () => void;
}) {
	const [locked, setLocked] = useState(trip.schedule_locked === 1);
	return (
		<TripFormDialog
			title={c.editDialog.title}
			submitLabel={copy.common.save}
			busyLabel={copy.common.saving}
			fallback={c.editDialog.fallback}
			footerStart={<DeleteButton name={trip.name} onClick={onDelete} />}
			fields={
				<label className="flex cursor-pointer items-center gap-2.5 select-none">
					<CheckBox checked={locked} onChange={() => setLocked((on) => !on)} />
					<span className="min-w-0">{c.editDialog.lockLabel}</span>
				</label>
			}
			initial={{
				name: trip.name,
				startDate: trip.start_date ?? '',
				endDate: trip.end_date ?? '',
				currency: trip.home_currency
			}}
			onClose={onClose}
			onSubmit={async (v) => {
				await api(`/trips/${trip.id}`, {
					method: 'PATCH',
					body: {
						name: v.name,
						startDate: v.startDate,
						endDate: v.endDate,
						currency: v.currency,
						scheduleLocked: locked
					}
				});
				onSaved();
				onClose();
			}}
		/>
	);
}
