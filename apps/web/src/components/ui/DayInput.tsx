import { useEffect, useState } from 'react';
import type React from 'react';

/**
 * A date box that can be typed into.
 *
 * A native date input reports every keystroke as a whole value, and the
 * in-between ones are real dates: typing the year "2026" a digit at a time
 * passes through 0002, 0020 and 0202. The forms used to clamp each of those to
 * the trip on the spot, so the box jumped to the trip's first day after the
 * first digit and nothing could be typed at all; only the picker worked.
 *
 * So the box keeps what is being typed to itself. A complete date inside
 * `min`..`max` is passed on at once, which is every pick from the calendar and
 * the end of most typing; anything else waits until the box is left (or Enter
 * is pressed), and is then brought into range, which is the clamp the forms
 * already wanted. The value shown always ends up being the value the form holds.
 */
export default function DayInput({
	value,
	min,
	max,
	floor = min,
	onDay,
	...input
}: {
	value: string;
	min: string;
	max: string;
	/**
	 * The earliest day a typed date is held to, when that is earlier than the
	 * picker's `min`. An end date's picker starts at the start date, but an
	 * earlier one typed in is kept so the form can say why it cannot be saved,
	 * rather than being quietly moved.
	 */
	floor?: string;
	/** A day inside `floor`..`max`. Never called with an empty or partial value. */
	onDay: (day: string) => void;
} & Omit<React.ComponentPropsWithRef<'input'>, 'value' | 'onChange' | 'type' | 'min' | 'max'>) {
	const [draft, setDraft] = useState(value);
	const [typing, setTyping] = useState(false);

	// The form moved the date (the start carried the end, a drag, a reset):
	// show that, unless this box is the one being typed into.
	useEffect(() => {
		if (!typing) setDraft(value);
	}, [value, typing]);

	const inRange = (day: string) => isDay(day) && day >= floor && day <= max;

	const settle = () => {
		setTyping(false);
		const next = isDay(draft) ? (draft < floor ? floor : draft > max ? max : draft) : value;
		setDraft(next);
		if (next !== value) onDay(next);
	};

	return (
		<input
			{...input}
			type="date"
			min={min}
			max={max}
			value={draft}
			onFocus={(e) => {
				setTyping(true);
				input.onFocus?.(e);
			}}
			onChange={(e) => {
				const typed = e.target.value;
				setDraft(typed);
				if (inRange(typed) && typed !== value) onDay(typed);
			}}
			onBlur={(e) => {
				settle();
				input.onBlur?.(e);
			}}
			onKeyDown={(e) => {
				// An unapplied date is applied first, rather than submitting the
				// form with the one it is about to replace.
				if (e.key === 'Enter' && draft !== value) {
					e.preventDefault();
					settle();
				}
				input.onKeyDown?.(e);
			}}
		/>
	);
}

/** A whole `YYYY-MM-DD` with a four-digit year from this millennium or the next. */
function isDay(v: string): boolean {
	return /^[12]\d{3}-\d{2}-\d{2}$/.test(v);
}
