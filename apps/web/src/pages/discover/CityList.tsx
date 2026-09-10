import { useState } from 'react';
import { api } from '../../lib/api';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import type { Trip } from '../TripShell';
import { PlusIcon, RemoveCardButton } from './card-controls';
import { copy } from '../../copy';

const cl = copy.discover.cityList;

export type CityRow = {
	id: string;
	name: string;
	/**
	 * The state / province, and only when this list contains another city with
	 * the same name. Discover fills it in conditionally (see `Discover.tsx`)
	 * because this sidebar is a lookup, not a gazetteer: hanging "Kanagawa" off
	 * a lone Kamakura buys nothing and costs a line of width in a 190px column.
	 * Absent, null and blank all render as nothing.
	 */
	region?: string | null;
	/** The count shown beside the name, which follows the current view. */
	badge: number;
	places: number;
	stays: number;
	/** Calendar items scheduled from a place in this city. */
	linked: number;
};

/**
 * The city sidebar.
 *
 * The axis of this page was swapped: the sidebar used to switch between Places
 * and Stays while a dropdown in the header chose the city, which put the rarely
 * changed choice in the persistent control and the frequently changed one in a
 * popup. Cities are the thing everything on the page is scoped to, so they are
 * the standing list; what kind of thing you are looking at moved into the
 * header dropdown.
 *
 * Alphabetical, not itinerary order: this is a lookup ("where is Kyoto?"), and
 * the itinerary's own order is what the calendar reads from.
 *
 * Adding and deleting a city are organizer-only *on the server*, so the
 * controls are hidden from everyone else rather than shown and refused.
 */
export default function CityList({
	trip,
	cities,
	value,
	onChange,
	isOrganizer,
	onAddCity,
	onChanged
}: {
	trip: Trip;
	cities: CityRow[];
	value: string;
	onChange: (cityId: string) => void;
	isOrganizer: boolean;
	/**
	 * Opens the add-city dialog. That dialog used to list the trip's cities and
	 * offer removals too, which was this sidebar's job done a second time, so it
	 * now only adds and this list stays the one place a city is deleted.
	 */
	onAddCity: () => void;
	/** Reloads the trip and the page data after a city is added. */
	onChanged: () => void;
}) {
	const [pendingDelete, setPendingDelete] = useState<CityRow | null>(null);

	// The server refuses to remove the last city, because a trip without one is
	// the dead end the add route exists to get out of.
	const canDelete = cities.length > 1;

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<nav className="secnav" aria-label={cl.navLabel}>
				{cities.map((c) => {
					const on = c.id === value;
					return (
						// The delete button is overlaid rather than laid out beside the
						// row, so a city button is exactly as wide as the Add city button
						// under it. Given away as a column it cost every row 28px of an
						// already narrow lane, and left the nav visibly out of line with
						// the only other control in this sidebar.
						<div key={c.id} className="group/card relative flex min-w-0 items-center">
							<button
								type="button"
								// The trailing room is reserved whether or not the button is
								// showing, so revealing it on hover never reflows the label
								// or nudges the badge sideways. Only organizers can delete,
								// so only they pay for the space.
								className={`${on ? 'sec on' : 'sec'}${isOrganizer ? ' pr-10' : ''}`}
								aria-current={on ? 'true' : undefined}
								// The region is set only when a same-named city is in the
								// list, and the column is narrow enough to ellipsise it, so
								// the full label is on the hover title as well.
								title={c.region ? `${c.name}, ${c.region}` : undefined}
								onClick={() => onChange(c.id)}
							>
								<span className="lbl">
									{c.name}
									{c.region && <span className="muted ml-1.5 text-[0.78rem]">{c.region}</span>}
								</span>
								{c.badge > 0 && <span className="badge">{c.badge}</span>}
							</button>
							{isOrganizer && (
								// Disabled rather than hidden on the last city: a control that
								// vanishes as you delete down to one reads as a bug, and the
								// title says why it cannot be pressed.
								<RemoveCardButton
									label={cl.removeLabel(c.name)}
									onClick={() => setPendingDelete(c)}
									disabled={!canDelete}
									title={canDelete ? undefined : cl.lastCityTitle}
									className="absolute top-1/2 right-1 -translate-y-1/2"
								/>
							)}
						</div>
					);
				})}
			</nav>

			{isOrganizer && (
				<button type="button" className="btn small justify-center" onClick={onAddCity}>
					<PlusIcon />
					{cl.addCity}
				</button>
			)}

			<ConfirmDialog
				open={!!pendingDelete}
				title={pendingDelete ? cl.deleteTitle(pendingDelete.name) : ''}
				confirmLabel={cl.deleteConfirm}
				busyLabel={copy.common.deleting}
				body={pendingDelete && <DeleteBody city={pendingDelete} />}
				onCancel={() => setPendingDelete(null)}
				onConfirm={async () => {
					if (!pendingDelete) return;
					// No `useMutation` here on purpose: `ConfirmDialog` already owns the
					// busy flag and shows a throw in its own footer, so wrapping this in
					// a second state machine would just decide twice where the message
					// goes. Anything else on this page that writes goes through the hook.
					await api(`/trips/${trip.id}/cities/${pendingDelete.id}`, { method: 'DELETE' });
					// Deleting the city you were looking at leaves nothing selected, so
					// hand the page to whichever city is left.
					const next = cities.find((c) => c.id !== pendingDelete.id);
					if (pendingDelete.id === value && next) onChange(next.id);
					setPendingDelete(null);
					onChanged();
				}}
			/>
		</div>
	);
}

/**
 * What deleting a city actually takes with it, verified against the schema and
 * a real delete on a copy of the database rather than assumed:
 *
 *  - its places and stays cascade, and every vote on them goes too;
 *  - the city's estimated costs (both the per-category estimates and the
 *    itemised lines on Preparation) cascade;
 *  - scheduled calendar items do **not** go. Their FK is ON DELETE SET NULL, so
 *    the blocks keep their title and time slot and only lose the link back to
 *    the place. That is worth saying, because "deleting cascades to the
 *    calendar" is true of deleting one *place* and it would be reasonable to
 *    assume it is true here.
 */
function DeleteBody({ city }: { city: CityRow }) {
	return (
		<>
			{/* Carries the region when the sidebar had to disambiguate, because
			    this is the irreversible step and "Delete Springfield?" is not
			    enough to act on when the trip holds two of them. */}
			<p className="m-0 mb-2 font-semibold [overflow-wrap:anywhere]">
				{city.name}
				{city.region && <span className="muted ml-1.5 text-[0.78rem]">{city.region}</span>}
			</p>
			<p className="m-0 mb-2 text-[0.9rem]">{cl.deleteBody(city.places, city.stays, city.name)}</p>
			{city.linked > 0 && <p className="muted m-0 text-[0.9rem]">{cl.deleteLinked(city.linked)}</p>}
		</>
	);
}
