import Select from '../../components/ui/Select';
import { MAX_NOTES_LENGTH } from '@trippy/core/validate';
import { Field, FieldShell, TextArea } from '../../components/ui/Field';
import { copy } from '../../copy';

const c = copy.discover.placeFields;

/**
 * The field rows the add and the edit popup genuinely share.
 *
 * They are not one dialog and should not become one: adding is a search against
 * a places provider that fills a form from a result and can switch between a
 * place and a stay, while editing is a small PATCH of the four things a
 * traveller typed. Forcing those together would need a `mode` flag and a branch
 * in every other line.
 *
 * What is actually identical is the bottom half of both forms: the same three
 * rows, written out twice, down to the textarea's `rows`, its class string and
 * the `https://` placeholder. Those live here, and each dialog keeps its own
 * layout, its own name field and its own submit.
 */

/** The bucket a place is filed under. Options differ per caller: the add popup
    also offers stays, which is not something an existing place can become. */
export function TypeField({
	options,
	value,
	onChange
}: {
	options: { value: string; label: string }[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<FieldShell label={c.typeLabel}>
			<Select options={options} value={value} onChange={onChange} ariaLabel={c.typeAriaLabel} />
		</FieldShell>
	);
}

export function NotesField({
	value,
	onChange
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<TextArea
			label={c.notesLabel}
			optional
			maxLength={MAX_NOTES_LENGTH}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

export function LinkField({
	value,
	onChange
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<Field
			label={c.linkLabel}
			optional
			type="url"
			placeholder={c.linkPlaceholder}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			inputClassName="w-full"
		/>
	);
}
