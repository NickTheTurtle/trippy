import SearchPicker from './SearchPicker';
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
 * The typing, and the value that shows when nobody is typing, are
 * `SearchPicker`, which the home time zone shares. What is left here is what
 * is particular to a currency: searching by code or by name, and a row that
 * leads with the code.
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
	return (
		<SearchPicker
			options={codes}
			value={value}
			onChange={onChange}
			search={searchCurrencies}
			label={label}
			ariaLabel={ariaLabel}
			className={className}
			// The code first and unmuted: it is the value, and it is what people
			// scan for. The name is there to be searched and to settle which of
			// two codes this is.
			renderItem={(code) => (
				<span className="flex items-baseline gap-2">
					<span className="font-medium">{code}</span>
					<span className="muted min-w-0 truncate text-meta">{currencyName(code)}</span>
				</span>
			)}
			noMatches={copy.ui.currencyPicker.noMatches}
		/>
	);
}
