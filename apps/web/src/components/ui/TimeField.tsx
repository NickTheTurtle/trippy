/**
 * A typed clock, in the shape macOS uses.
 *
 * A dropdown of every quarter-hour is 72 rows long, and the reader who knows
 * the answer has to hunt for it: setting 14:45 meant opening a list, scrolling
 * most of the way down it and hitting one row among seventy. Typing it is four
 * keystrokes and needs no aim.
 *
 * Two segments rather than a free text box, because a free box has to be parsed
 * and can be wrong: "2pm", "1430", "half two". Each segment holds a number and
 * nothing else, so there is no input the field has to refuse. Arrows step it,
 * digits replace it, and the caret moves on by itself once the hour can take no
 * more digits, which is what makes "1", "4", "4", "5" land on 14:45.
 *
 * The value is minutes past midnight, the unit the board and the server both
 * speak, so nobody parses a clock.
 */
import { useRef, useState } from 'react';

/** The board runs to midnight, and midnight is 24:00 rather than 0:00. */
const DAY_END = 24 * 60;

const pad = (n: number) => String(n).padStart(2, '0');

export default function TimeField({
	value,
	onChange,
	onCommit,
	ariaLabel,
	step = 5
}: {
	/** Minutes past midnight. */
	value: number;
	onChange: (min: number) => void;
	/** Fired when focus leaves the field, for a caller that needs to normalize. */
	onCommit?: () => void;
	ariaLabel: string;
	/** What an arrow key is worth on the minute segment. */
	step?: number;
}) {
	const hour = Math.floor(value / 60);
	const min = value % 60;

	const box = useRef<HTMLDivElement>(null);
	const minRef = useRef<HTMLSpanElement>(null);
	/* What has been typed into the hour so far. A lone "1" could still become
	   "14", so the segment waits for a second digit before moving on, and
	   forgets what it saw the moment focus or segment changes. */
	const [typed, setTyped] = useState('');

	/* Midnight is the end of the board, not the start of it, so the hour runs to
	   24 and the field clamps rather than wrapping: an event cannot run past the
	   day it is on, and 24:15 is not a time. */
	const set = (h: number, m: number) => onChange(Math.max(0, Math.min(DAY_END, h * 60 + m)));

	const segment = (
		which: 'h' | 'm',
		{ shown, max, bump }: { shown: string; max: number; bump: (d: number) => void }
	) => {
		const digits = (d: string) => {
			if (which === 'm') {
				// Two digits and the minute is full; a first digit above 5 cannot be
				// the tens of a minute, so it stands alone.
				const next = typed.length === 1 && Number(typed + d) < 60 ? typed + d : d;
				setTyped(next.length === 2 || Number(next) > 5 ? '' : next);
				set(hour, Number(next));
				return;
			}
			const next = typed.length === 1 && Number(typed + d) <= 24 ? typed + d : d;
			set(Number(next), min);
			if (next.length === 2 || Number(next) > 2) {
				setTyped('');
				minRef.current?.focus();
			} else setTyped(next);
		};

		return (
			<span
				ref={which === 'm' ? minRef : undefined}
				className={`tfseg tf${which}`}
				role="spinbutton"
				tabIndex={0}
				aria-label={`${ariaLabel} ${which === 'h' ? 'hour' : 'minute'}`}
				aria-valuenow={which === 'h' ? hour : min}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuetext={shown}
				onFocus={() => setTyped('')}
				onKeyDown={(e) => {
					if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
						e.preventDefault();
						setTyped('');
						bump(e.key === 'ArrowUp' ? 1 : -1);
					} else if (/^[0-9]$/.test(e.key)) {
						e.preventDefault();
						digits(e.key);
					} else if (e.key === ':' || (e.key === 'ArrowRight' && which === 'h')) {
						e.preventDefault();
						minRef.current?.focus();
					} else if (e.key === 'ArrowLeft' && which === 'm') {
						e.preventDefault();
						(
							minRef.current?.previousElementSibling?.previousElementSibling as HTMLElement
						)?.focus();
					}
				}}
			>
				{shown}
			</span>
		);
	};

	return (
		<div
			ref={box}
			className="input tfield"
			onBlur={(e) => {
				if (box.current?.contains(e.relatedTarget as Node)) return;
				setTyped('');
				onCommit?.();
			}}
			onClick={(e) => {
				// Clicking the padding, rather than a segment, lands on the hour.
				if (e.target === box.current) (box.current?.firstElementChild as HTMLElement)?.focus();
			}}
		>
			{segment('h', {
				shown: String(hour),
				max: 24,
				bump: (d) => set(hour + d, min)
			})}
			<span className="tfcolon">:</span>
			{segment('m', {
				shown: pad(min),
				max: 59,
				// Stepping the minute past an hour boundary wraps inside the hour
				// rather than carrying: the reader stepping minutes is not asking to
				// change the hour, and the hour is one key away.
				bump: (d) => set(hour, (((min + d * step) % 60) + 60) % 60)
			})}
		</div>
	);
}
