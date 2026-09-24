import { useMemo, useState, type ReactNode } from 'react';
import SearchDropdown from './SearchDropdown';

/**
 * A value chosen by typing, from a list the client already holds.
 *
 * The part of `CurrencyPicker` that was never about currencies, lifted out when
 * the home time zone needed the same thing: that field was a `Select` over
 * some four hundred IANA zones with no way to type, which is the list-too-long
 * problem the currency field had already solved once.
 *
 * `SearchDropdown` is the app's typeahead and already has the parts that are
 * easy to get wrong: arrow navigation, Enter to pick, Escape that closes the
 * popup without closing the dialog behind it, and the combobox roles. It was
 * written for an asynchronous search, which is the one thing a local list is
 * not, so the only thing it needed was `openOnEmpty`: a local list is complete,
 * so an empty query is all of it rather than none.
 *
 * What is here is the rest of that difference. A search box holds a query;
 * this holds a value, and the value has to be readable when nobody is typing
 * in it. So the input shows the chosen value whenever the field is not
 * focused, and becomes the query while it is, with the chosen value as the
 * placeholder behind it. Escape and blur both empty the query, which puts the
 * value back on screen unchanged.
 */
export default function SearchPicker({
	options,
	value,
	onChange,
	search,
	display = (v) => v,
	renderItem,
	noMatches,
	label,
	ariaLabel,
	className = ''
}: {
	options: readonly string[];
	value: string;
	onChange: (value: string) => void;
	/** The options matching a query, in the order to offer them. */
	search: (options: readonly string[], query: string) => string[];
	/** How a value reads in the box when nobody is typing. */
	display?: (value: string) => string;
	renderItem: (value: string) => ReactNode;
	noMatches: string;
	label: string;
	ariaLabel?: string;
	className?: string;
}) {
	const [query, setQuery] = useState('');
	/** Typing beats showing: the input is the query only while it has focus. */
	const [typing, setTyping] = useState(false);
	const [open, setOpen] = useState(false);

	const matches = useMemo(() => {
		const found = search(options, query);
		// Unfiltered, the current value goes first. It is the row most likely to
		// be wanted, and `SearchDropdown` starts the highlight on the first row,
		// so Enter straight after opening keeps the value rather than replacing
		// it with whichever option happens to sort first.
		if (query.trim() || !value) return found;
		return [value, ...found.filter((v) => v !== value)];
	}, [options, search, query, value]);

	return (
		<div
			className={`min-w-0 ${className}`}
			// Focus reaches here from the input by bubbling, and the input is the
			// only thing inside that takes focus, so this is the whole of it.
			onFocus={() => {
				setTyping(true);
				setOpen(true);
			}}
			onBlur={() => {
				setTyping(false);
				setQuery('');
			}}
			// Clicking a field that is already focused has to reopen it, otherwise
			// Escape leaves a picker that only the keyboard can get back into. The
			// rows are inside this too and must not reopen what the pick just shut.
			onClick={(e) => {
				if ((e.target as HTMLElement).tagName === 'INPUT') setOpen(true);
			}}
		>
			<SearchDropdown
				label={label}
				ariaLabel={ariaLabel}
				value={typing ? query : display(value)}
				placeholder={display(value)}
				onChange={(v) => {
					setQuery(v);
					setOpen(true);
				}}
				open={open}
				onOpenChange={(v) => {
					setOpen(v);
					if (!v) setQuery('');
				}}
				openOnEmpty
				items={matches}
				itemKey={(v) => v}
				onPick={(v) => {
					onChange(v);
					setQuery('');
					setOpen(false);
				}}
				renderItem={renderItem}
				empty={noMatches}
			/>
		</div>
	);
}
