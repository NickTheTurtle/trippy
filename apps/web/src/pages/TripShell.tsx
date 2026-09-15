import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useTripEvents, TripEventsProvider } from '../hooks/useTripEvents';
import useMediaQuery from '../hooks/useMediaQuery';
import { TABS } from '../nav';
import AddCityDialog from '../components/AddCityDialog';
import TripFormDialog from '../components/TripFormDialog';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import UiAvatar from '../components/ui/Avatar';
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
	const { data, error, reload } = useApi<{ trip: Trip }>(`/trips/${tripId}`);
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

	// The header carries the name, the dates, the member avatars and the city
	// strip, so it follows all three of those topics.
	useEffect(() => events.subscribe(['trip', 'members', 'schedule'], reload), [events, reload]);

	// `useApi` deliberately keeps the previous response while the next one is in
	// flight, which is what stops a reload blanking the page. Switching trips
	// goes through the same state, though, so the loaded trip has to be checked
	// against the one in the URL: without this the header, the tabs and every
	// section below render the trip you just left for as long as the fetch takes.
	const trip = data && data.trip.id === tripId ? data.trip : null;

	if (!trip) {
		if (!error) return null;
		return (
			<main className="container py-8">
				<p>
					{c.notFound}{' '}
					<Link to="/trips" className="text-accent-ink underline">
						{c.notFoundLink}
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
	 * lying about how many were left out. */
	const faces = wideHeader ? 8 : mediumHeader ? 5 : 3;
	const extra = trip.members.length - faces;

	return (
		<TripEventsProvider value={events}>
			<div className="border-b border-line bg-surface">
				<div className="container">
					<Link
						to="/trips"
						className="inline-block pt-5 pb-2.5 text-body text-ink-faint hover:text-accent"
					>
						{c.backToTrips}
					</Link>

					<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
						{/* A real basis, not just `min-w-0`: a title that can shrink to
						    nothing never pushes the roster onto its own line, and the
						    header collapsed to one letter per line on a phone. */}
						<div className="min-w-0 flex-1 basis-72">
							<h1 className="text-title [overflow-wrap:anywhere]">{trip.name}</h1>
							<p className="muted">{trip.dates}</p>
						</div>

						<div className="flex shrink-0 items-center">
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
					confirming === 'leave' ? c.leaveDialog.title(trip.name) : c.deleteDialog.title(trip.name)
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
	return (
		<TripFormDialog
			title={c.editDialog.title}
			submitLabel={copy.common.save}
			busyLabel={copy.common.saving}
			fallback={c.editDialog.fallback}
			footerStart={
				<button type="button" className="btn danger" onClick={onDelete}>
					{copy.common.delete}
				</button>
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
					body: { name: v.name, startDate: v.startDate, endDate: v.endDate, currency: v.currency }
				});
				onSaved();
				onClose();
			}}
		/>
	);
}
