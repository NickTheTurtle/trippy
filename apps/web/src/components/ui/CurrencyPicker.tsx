import { useMemo, useState } from 'react';
import SearchDropdown from './SearchDropdown';
import { currencyName, searchCurrencies } from '../../lib/currencies';
import { copy } from '../../copy';

/**
 * The currency field: a code, chosen by typing.
 *
 * It was a `Select`, which is fine for the twenty codes of the offline rate
 * table and hopeless for what the server actually sends. Live rates take the
 * list to roughly a hundred and sixty entries, so picking a currency meant
 * scrolling that many unlabelled three-letter codes with no way to type.
 *
 * `SearchDropdown` is the app's typeahead and already has the parts that are
 * easy to get wrong: arrow navigation, Enter to pick, Escape that closes the
 * popup without closing the dialog behind it, and the combobox roles. It was
 * written for an asynchronous search, which is the one thing a currency is not,
 * so the only thing it needed was `openOnEmpty`: a local list is complete, so
 * an empty query is all of it rather than none.
 *
 * What is local here is the rest of that difference. A search box holds a
 * query; this holds a value, and the value has to be readable when nobody is
 * typing in it. So the input shows the chosen code whenever the field is not
 * focused, and becomes the query while it is, with the chosen code as the
 * placeholder behind it. Escape and blur both empty the query, which puts the
 * value back on screen unchanged.
 */
export default function CurrencyPicker({
	codes,
	value,
	onChange,
	label,
	ariaLabel,
	className = ''
}: {
	/** The server's list when there is one, else the offline codes. */
	codes: readonly string[];
	value: string;
	onChange: (code: string) => void;
	label: string;
	ariaLabel?: string;
	className?: string;
}) {
	const [query, setQuery] = useState('');
	/** Typing beats showing: the input is the query only while it has focus. */
	const [typing, setTyping] = useState(false);
	const [open, setOpen] = useState(false);

	const matches = useMemo(() => {
		const found = searchCurrencies(codes, query);
		// Unfiltered, the current value goes first. It is the row most likely to
		// be wanted, and `SearchDropdown` starts the highlight on the first row,
		// so Enter straight after opening keeps the value rather than replacing
		// it with whichever code happens to sort first.
		if (query.trim() || !value) return found;
		return [value, ...found.filter((code) => code !== value)];
	}, [codes, query, value]);

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
				value={typing ? query : value}
				placeholder={value}
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
				itemKey={(code) => code}
				onPick={(code) => {
					onChange(code);
					setQuery('');
					setOpen(false);
				}}
				// The code first and unmuted: it is the value, and it is what people
				// scan for. The name is there to be searched and to settle which of
				// two codes this is.
				renderItem={(code) => (
					<span className="flex items-baseline gap-2">
						<span className="font-medium">{code}</span>
						<span className="muted min-w-0 truncate text-meta">{currencyName(code)}</span>
					</span>
				)}
				empty={copy.ui.currencyPicker.noMatches}
			/>
		</div>
	);
}
