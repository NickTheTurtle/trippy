import type { ChangeEvent } from 'react';
import { CheckIcon } from './icons';

/**
 * A checkbox that draws its own tick.
 *
 * The native control paints a glyph the platform chooses and sets slightly high
 * of centre, which reads as a misprint next to our own square. The real input
 * stays, invisible, on top of the drawing so focus, labels and the keyboard all
 * behave as they always did.
 */
export function CheckBox({
	checked,
	onChange,
	disabled
}: {
	checked: boolean;
	onChange: (e: ChangeEvent<HTMLInputElement>) => void;
	disabled?: boolean;
}) {
	return (
		<span className={checked ? 'cbox on' : 'cbox'}>
			<input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
			{checked && <CheckIcon />}
		</span>
	);
}
