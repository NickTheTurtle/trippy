import { useState } from 'react';
import SearchDropdown from '../../components/ui/SearchDropdown';
import { MIN_QUERY } from '../discover/place-meta';
import type { Option } from '../../components/ui/Select';
import type { PlaceHit } from '../../lib/api-types';
import { copy } from '../../copy';

const cps = copy.schedule.placeSearch;

/** A saved place, or a result the provider offered under it. */
type Row = { saved: Option; head: string | null } | { hit: PlaceHit; head: string | null };

const isHit = (r: Row): r is { hit: PlaceHit; head: string | null } => 'hit' in r;

/**
 * Where an event happens: one of the trip's saved places, somewhere found on
 * the provider, or a name typed by hand.
 *
 * It used to be a plain `Select` over the saved places, which made the calendar
 * unable to record the most ordinary thing a group does. A restaurant chosen on
 * the pavement is not in Discover, is not worth adding to Discover for one
 * meal, and had nowhere to go but the notes. So the field is a combobox, and
 * typing into it does two things at once: it narrows the shortlist, and it asks
 * the provider. The shortlist comes first because it is free, certain and
 * usually the answer; the provider's results sit underneath it, because
 * searching the world is what you fall back to when the trip's own list does
 * not have the place.
 *
 * This replaced a Search button that opened Discover's add popup. Two dialogs
 * deep to name a restaurant was a lot of ceremony for one field, and the popup
 * asked again for the name that had already been typed here.
 *
 * A name matching nothing, picked from neither list, is still kept as typed.
 * There is no geocoding behind the box itself, deliberately: a lookup per
 * keystroke is a metered provider call in a loop, and "the tapas place near the
 * square" has no coordinates to find. An event named that way is named, and is
 * no more located than an event with no place at all. Picking a provider result
 * is how it gets located, and that is a deliberate act with a request behind it.
 *
 * `SearchDropdown` rather than a new control: it is the app's combobox, it
 * already handles the roles, the arrows, Escape and the fixed-position menu
 * that has to escape the dialog's scrolling body.
 */
export default function PlaceField({
	label,
	options,
	value,
	onChange,
	hits,
	searching = false,
	searched = false,
	onPickHit,
	attribution,
	busy = false,
	className = ''
}: {
	label: string;
	/** The saved places, already filtered and grouped by `placeOptions`. */
	options: Option[];
	/** What the box reads: a saved place's name, or whatever was typed. */
	value: string;
	/** `id` is empty when the text matches no saved place, which is the typed case. */
	onChange: (text: string, id: string) => void;
	/** What the provider offered for what is typed. Empty when there is no search. */
	hits?: PlaceHit[];
	searching?: boolean;
	/** Whether a search has come back for what is in the box, so "nothing found" is true. */
	searched?: boolean;
	/** Saves the result as a place and links it. Absent when there is nothing to search. */
	onPickHit?: (hit: PlaceHit) => void;
	/** The provider's attribution line. It has to travel with its results. */
	attribution?: string;
	/** True while a picked result is being saved, which is a request the reader waits on. */
	busy?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	/* Whether the text in the box was typed into it just now, as opposed to left
	   there by a pick or by the event it opened on. Only a query someone is
	   actually typing narrows the list: opening the box on a name it already
	   holds and being shown one row, or none, would hide every alternative at
	   exactly the moment the reader went looking for one. */
	const [typing, setTyping] = useState(false);

	const query = value.trim();
	const needle = query.toLowerCase();
	const saved =
		typing && needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

	/* The provider's results only ever follow a query somebody typed, so they are
	   hidden the moment the box is reopened on a name it already holds: the list
	   would otherwise reappear underneath a place that has already been chosen. */
	const found = typing && onPickHit ? (hits ?? []) : [];
	/* Two lists in one menu need saying which is which: a name under the trip's
	   own shortlist and the same name under the provider's answer mean different
	   things. The headings only appear once a query is in play, because a field
	   opened to browse the shortlist has nothing to tell apart. */
	const headed = typing && !!onPickHit;
	const items: Row[] = [
		...saved.map((o, i) => ({ saved: o, head: headed && i === 0 ? 'Saved' : null })),
		...found.map((h, i) => ({ hit: h, head: headed && i === 0 ? 'Results' : null }))
	];

	return (
		/* A press on the box opens it. `SearchDropdown` opens on typing and on the
		   arrows, which is right for a search that costs a request, but the saved
		   list is already in memory and a picker that shows nothing until you guess
		   at it is not browsable. The mousedown is filtered to the input itself so
		   that clicking a row, which keeps focus in the input, does not reopen the
		   menu the pick just closed.

		   Focus alone deliberately does not open it. The event dialog puts the
		   caret in this field when it opens, and a menu that opened on focus came
		   up with its first row highlighted: the Enter a reader pressed to save
		   what they had come to change picked that row instead, and swapped the
		   block's place without a word. A tap is a mousedown too, so a phone still
		   opens the list the moment the box is touched; a keyboard asks with the
		   down arrow, the same as every other combobox in the app. */
		<div
			className={className}
			onMouseDownCapture={(e) => {
				if ((e.target as HTMLElement).tagName !== 'INPUT') return;
				setOpen(true);
				setTyping(false);
			}}
		>
			<SearchDropdown
				label={label}
				ariaLabel={label}
				value={value}
				onChange={(text) => {
					// Typing unlinks. The id and the text are one field, and text that
					// nobody picked cannot go on claiming the coordinates of a place it
					// no longer names.
					onChange(text, '');
					setOpen(true);
					setTyping(true);
				}}
				open={open}
				onOpenChange={setOpen}
				openOnEmpty
				busy={busy || (typing && searching)}
				items={items}
				itemKey={(r) =>
					isHit(r) ? `hit:${r.hit.id ?? ''}|${r.hit.name}|${r.hit.address ?? ''}` : r.saved.value
				}
				renderItem={(r) =>
					isHit(r) ? (
						<span className="flex min-w-0 flex-col">
							<span className="truncate font-medium">{r.hit.name}</span>
							{r.hit.address && <span className="muted truncate text-meta">{r.hit.address}</span>}
						</span>
					) : (
						<span className="flex min-w-0 items-baseline gap-2">
							<span className="truncate">{r.saved.label}</span>
							{/* The city and the votes, which is what `placeOptions` grouped
							    and sorted by. A flat combobox has no headings to put the
							    city in, so it travels on the row instead of being dropped. */}
							<span className="text-meta muted shrink-0">
								{[r.saved.section, r.saved.hint].filter(Boolean).join(', ')}
							</span>
						</span>
					)
				}
				sectionOf={(r) => r.head}
				onPick={(r) => {
					if (isHit(r)) {
						// The name lands immediately; the link follows when the place has
						// been saved, which is a request away.
						onChange(r.hit.name, '');
						onPickHit?.(r.hit);
					} else onChange(r.saved.label, r.saved.value);
					setOpen(false);
					setTyping(false);
				}}
				empty={
					!typing || !query
						? null
						: searching
							? cps.searching
							: onPickHit && query.length < MIN_QUERY
								? cps.keepTyping
								: onPickHit && searched
									? cps.nothingFound
									: cps.noMatch
				}
				footer={
					found.length > 0 && attribution ? (
						<p className="m-0 px-2 pt-1 text-right text-micro text-ink-faint">{attribution}</p>
					) : undefined
				}
			/>
		</div>
	);
}
