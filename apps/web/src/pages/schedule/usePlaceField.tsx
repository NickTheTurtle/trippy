import { useState } from 'react';
import { isLocatedType, type EventType } from '@trippy/core/types';
import PlaceField from './PlaceField';
import { usePlaceLookup } from './usePlaceSearch';
import { keepsPick, placeLabel, placeOptions } from './shared';
import type { Cell, SavedPoi } from './types';

/**
 * Where a block is, as the dialogs ask for it.
 *
 * Adding a block and editing one ask the same question of the same board, and
 * the answer is the same small state machine either way: an id when one of the
 * trip's saved places was picked, the text in the box either way, and a typed
 * name that matches nothing keeping the id empty. That pair is what a save
 * sends, and telling the two apart is what tells "scheduled at the Acropolis"
 * from "scheduled at somewhere I have only written the name of".
 *
 * It was written out twice, once per dialog, down to the search wiring and the
 * field itself. The two copies had already begun to drift: one guarded the
 * picked place by whether the type can hold one and the other guarded it at
 * three later call sites instead. Kept here, there is one of it.
 *
 * `usePlaceLookup` is still the thing underneath that talks to the provider.
 * This is the layer above it: the state the field holds, the list it offers,
 * and the field itself.
 *
 * It returns a node rather than props to spread, which is the pattern
 * `useJourneys` and `useDeleteAction` already use in this app: the caller
 * decides where it goes and how wide it is, and nothing else about it.
 */
export function usePlaceField({
	base,
	type,
	cities,
	cityId,
	saved,
	stays,
	provider,
	initialPoi = '',
	initialPlace = '',
	className = 'col-span-8'
}: {
	/** The schedule's own base, `/trips/:tripId/schedule`. */
	base: string;
	/** The block's type, which decides both whether it has a place and what kind. */
	type: EventType;
	cities: (Cell | null)[];
	cityId: string | null;
	/** The trip's saved places, for everything that is not a stay. */
	saved: SavedPoi[];
	/** The proposed stays a stay block can be booked into. */
	stays: SavedPoi[];
	/** Who answers the place search, for the attribution under its results. */
	provider?: 'google' | 'osm';
	/** The link and the name the field opens on. */
	initialPoi?: string;
	initialPlace?: string;
	/** How wide the field sits in its dialog's 12-column grid. */
	className?: string;
}) {
	const [poi, setPoi] = useState(initialPoi);
	const [place, setPlace] = useState(initialPlace);

	// Free time is deliberately nowhere, so it is the one type with no location.
	// A journey's location is the far end of it: where it puts you, and where
	// the rest of the day is then planned from.
	const placeable = isLocatedType(type);
	const staying = type === 'stay';

	/* The provider search is biased to a city, so a day without one searches
	   nothing and the field is the saved list alone. */
	const searchCity = cities.find((c): c is Cell => c?.id === cityId) ?? null;
	const { found, onTyped, fieldProps } = usePlaceLookup({
		base,
		city: searchCity,
		type,
		provider,
		onPicked: (made, stay) => {
			setPlace(made.name);
			// Linked only when the block can hold what was added: a hotel found
			// from an activity is saved to the trip either way, but this block is
			// not the thing that books it.
			setPoi(stay === staying ? made.id : '');
		}
	});

	/* One picker, two lists: a stay is booked into one of the stays the group is
	   voting on, everything else happens at a saved place. The field is asking
	   the same question either way, which of the things we have already
	   shortlisted is this, so it stays one field. Anything the provider search
	   added while the dialog has been open goes in front of both: the newest
	   thing is the thing being looked for. */
	const pickable = staying ? [...found.stays, ...stays] : [...found.places, ...saved];

	/** The saved place the block currently points at, if it can point at one. */
	const spot = placeable ? (pickable.find((p) => p.id === poi) ?? null) : null;

	/**
	 * Drops a pick the new type cannot hold, and the name it wrote with it.
	 *
	 * Leaving the text behind would silently turn a picked place into a typed
	 * one: the box would still read "Hotel Grande" while the link that gave it
	 * coordinates had gone.
	 *
	 * Called by the caller's Type select before it sets the new type, because
	 * the decision needs both the type being left and the one being arrived at.
	 */
	const retype = (next: EventType) => {
		if (keepsPick(type, next, spot)) return;
		setPoi('');
		setPlace('');
	};

	const field = placeable ? (
		<PlaceField
			label={placeLabel(type)}
			className={className}
			options={placeOptions(pickable, cities, cityId, type)}
			value={place}
			onChange={(text, id) => {
				setPlace(text);
				setPoi(id);
				// Only a typed query searches. A pick puts a name in the box that
				// nobody asked the provider for.
				onTyped(id ? '' : text);
			}}
			{...fieldProps}
		/>
	) : null;

	return { poi, place, spot, pickable, placeable, field, retype };
}
