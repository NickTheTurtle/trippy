import { useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Select from '../../components/ui/Select';
import { IconButton } from '../../components/ui/buttons';
import { useNarrowLayout } from '../../hooks/useMediaQuery';
import type { Trip } from '../TripShell';
import { RemoveCardButton } from './card-controls';
import { PlusIcon, TrashIcon } from '../../components/ui/icons';
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
	/** Everything saved in the city, whatever its type. */
	items: number;
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
 *
 * Below `lg` the page drops the column this sits in, and the list becomes a
 * dropdown in the header with the organizer's add and delete beside it. It is
 * a filter rather than a destination, so it does not go behind the menu button
 * the Preparation and Expenses sections use: those switch what you are looking
 * at, this one switches what you are looking at it *for*.
 */
export default function CityList({
	trip,
	cities,
	value,
	onChange,
	isOrganizer,
	onAddCity,
	onChanged,
	action
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
	/**
	 * The page's own primary button, shown at the end of this row at narrow
	 * widths, as on Preparation and Expenses. Wide, the page keeps it in its
	 * own header.
	 */
	action?: ReactNode;
}) {
	const [pendingDelete, setPendingDelete] = useState<CityRow | null>(null);
	const narrow = useNarrowLayout();

	// The server refuses to remove the last city, because a trip without one is
	// the dead end the add route exists to get out of.
	const canDelete = cities.length > 1;

	const column = (
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
									{c.region && <span className="muted ml-1.5 text-meta">{c.region}</span>}
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
		</div>
	);

	const current = cities.find((c) => c.id === value);

	return (
		<>
			{narrow ? (
				// A dropdown, not the drawer the other sections use: a city is what the
				// page is scoped to, not a place in it, and a filter belongs in the
				// header beside the grid it filters rather than behind a menu button
				// that reads like navigation (see docs/DESIGN.md M3.5).
				<div className="flex min-w-0 items-center gap-2">
					<Select
						options={cities.map((c) => ({
							value: c.id,
							label: c.region ? `${c.name}, ${c.region}` : c.name
						}))}
						value={value}
						onChange={onChange}
						ariaLabel={cl.navLabel}
					/>
					{isOrganizer && (
						<>
							<IconButton label={cl.addCity} onClick={onAddCity}>
								<PlusIcon />
							</IconButton>
							{/* A dropdown has no per-row affordance, so delete acts on the
							    city on screen. Disabled rather than dropped on the last
							    one, as in the column. */}
							<IconButton
								danger
								label={cl.removeLabel(current?.name ?? '')}
								disabled={!canDelete}
								onClick={() => current && setPendingDelete(current)}
								{...(canDelete ? {} : { title: cl.lastCityTitle })}
							>
								<TrashIcon />
							</IconButton>
						</>
					)}
					{action && <div className="ml-auto flex-none">{action}</div>}
				</div>
			) : (
				column
			)}

			<ConfirmDialog
				open={!!pendingDelete}
				title={pendingDelete ? cl.deleteTitle(pendingDelete.name, pendingDelete.region) : ''}
				busyLabel={copy.common.deleting}
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
		</>
	);
}
