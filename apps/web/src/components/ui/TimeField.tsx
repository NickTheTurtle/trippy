/**
 * A typed clock, in the shape macOS uses.
 *
 * A dropdown of every quarter-hour is 72 rows long, and the reader who knows
 * the answer has to hunt for it: setting 2:45 PM meant opening a list, scrolling
 * most of the way down it and hitting one row among seventy. Typing it is four
 * keystrokes and needs no aim.
 *
 * Segments rather than a free text box, because a free box has to be parsed and
 * can be wrong: "2pm", "1430", "half two". Each segment holds one thing and
 * nothing else, so there is no input the field has to refuse. Arrows step it,
 * digits replace it, and the caret moves on by itself once a segment can take
 * no more, which is what makes "2", "4", "5", "p" land on 2:45 PM.
 *
 * Twelve hours with a meridiem, because that is the clock the rest of the app
 * reads: the board, the blocks and the hour gutter all say "2:45 PM", and an
 * editor that opened on one of those blocks saying "14:45" was the one place
 * the app spoke a different clock from itself.
 *
 * The value is minutes past midnight, the unit the board and the server both
 * speak, so nobody parses a clock. That is unchanged: this is how a time is
 * read and typed, not what it is.
 */
import { useRef, useState, type RefObject } from 'react';

/** The board runs to midnight, and midnight is 24:00 rather than 0:00. */
const DAY_END = 24 * 60;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The hour a 24-hour hour reads as on a 12-hour clock: 1 to 12.
 *
 * Both midnights are 12, which is the whole reason this is arithmetic around
 * the wrap rather than a bare `h % 12`: "0:15 AM" is not a time anybody writes,
 * and the mistake is invisible until somebody is standing outside a closed door.
 */
const hour12 = (h24: number) => ((h24 + 11) % 12) + 1;

/** The 24-hour hour a reading names. 12 AM is 0 and 12 PM is 12. */
const hour24 = (h12: number, pm: boolean) => (h12 % 12) + (pm ? 12 : 0);

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
	const h24 = Math.floor(value / 60);
	const min = value % 60;
	/* The end of the board is 24:00, and it reads "12:00 AM" like any other
	   midnight: it is only ever shown as the far end of a span that started
	   earlier the same day, so there is nothing for the meridiem to settle.
	   Hence `< 24` rather than `>= 12` alone. */
	const pm = h24 >= 12 && h24 < 24;
	const h12 = hour12(h24);

	const box = useRef<HTMLDivElement>(null);
	const hourRef = useRef<HTMLSpanElement>(null);
	const minRef = useRef<HTMLSpanElement>(null);
	const apRef = useRef<HTMLSpanElement>(null);
	/* What has been typed into the current segment so far. A lone "1" could still
	   become "12", so the segment waits for a second digit before moving on, and
	   forgets what it saw the moment focus or segment changes. */
	const [typed, setTyped] = useState('');

	/* Midnight is the end of the board as well as the start of it, so the value
	   runs to 24:00 and the field clamps rather than wrapping: an event cannot
	   run past the day it is on, and 24:15 is not a time. */
	const set = (mins: number) => onChange(Math.max(0, Math.min(DAY_END, mins)));

	const setHour = (next: number) => set(hour24(next, pm) * 60 + min);
	const setMin = (next: number) => set(h24 * 60 + next);
	/* Swapping is a no-op when it would not move, so pressing "A" on a field that
	   already reads AM cannot turn the end of the day into the start of it. */
	const setPm = (next: boolean) => {
		if (next !== pm) set(hour24(h12, next) * 60 + min);
	};

	/**
	 * Digits into the hour, on a 1-to-12 clock.
	 *
	 * "1" is the only digit that can still be the tens of an hour, so it is the
	 * only one that waits; everything else stands alone and moves the caret on.
	 * A leading "0" waits too, because typing "0" then "9" for nine o'clock is a
	 * habit the old 24-hour field taught and there is no other hour it could be
	 * heading for.
	 */
	const hourDigits = (d: string) => {
		if (typed === '1' && '012'.includes(d)) {
			setTyped('');
			setHour(Number(`1${d}`));
			minRef.current?.focus();
			return;
		}
		if (typed === '0') {
			setTyped('');
			// "00" is not an hour, so a second zero simply leaves the segment where
			// it was rather than writing a time nobody asked for.
			if (d !== '0') {
				setHour(Number(d));
				minRef.current?.focus();
			}
			return;
		}
		if (d === '1' || d === '0') {
			// Unfinished by design: "1" may yet be 10, 11 or 12, and "0" may yet be
			// an hour typed with its leading zero.
			setTyped(d);
			// "1" is already a legible hour on its own; "0" is not, so it writes
			// nothing until the digit that follows it says which hour it was.
			if (d === '1') setHour(1);
			return;
		}
		setTyped('');
		setHour(Number(d));
		minRef.current?.focus();
	};

	/** Digits into the minute. A first digit above 5 cannot be a tens, so it stands alone. */
	const minDigits = (d: string) => {
		const next = typed.length === 1 && Number(typed + d) < 60 ? typed + d : d;
		const done = next.length === 2 || Number(next) > 5;
		setTyped(done ? '' : next);
		setMin(Number(next));
		if (done) apRef.current?.focus();
	};

	const digitSegment = (
		which: 'h' | 'm',
		{
			ref,
			shown,
			now,
			max,
			bump,
			digits,
			left,
			right
		}: {
			ref: RefObject<HTMLSpanElement | null>;
			shown: string;
			now: number;
			max: number;
			bump: (d: number) => void;
			digits: (d: string) => void;
			left?: RefObject<HTMLSpanElement | null>;
			right: RefObject<HTMLSpanElement | null>;
		}
	) => (
		<span
			ref={ref}
			className={`tfseg tf${which}`}
			role="spinbutton"
			tabIndex={0}
			aria-label={`${ariaLabel} ${which === 'h' ? 'hour' : 'minute'}`}
			aria-valuenow={now}
			aria-valuemin={which === 'h' ? 1 : 0}
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
				} else if (e.key === ':' || e.key === 'ArrowRight') {
					e.preventDefault();
					right.current?.focus();
				} else if (e.key === 'ArrowLeft' && left) {
					e.preventDefault();
					left.current?.focus();
				} else if (/^[aApP]$/.test(e.key)) {
					/* The meridiem answers from wherever the reader is: "2p" is how
					   anyone says two in the afternoon, and stopping to aim at a third
					   segment for one letter is the work the typed clock exists to
					   avoid. The caret follows the letter, so it is visible where it
					   landed. */
					e.preventDefault();
					setTyped('');
					setPm(/[pP]/.test(e.key));
					apRef.current?.focus();
				}
			}}
		>
			{shown}
		</span>
	);

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
				if (e.target === box.current) hourRef.current?.focus();
			}}
		>
			{digitSegment('h', {
				ref: hourRef,
				/* Unpadded, the way a twelve-hour clock is written and the way the
				   board already writes it: "9:30 AM", never "09:30 AM". The minute
				   keeps its pad, because a minute is always two digits. That pair is
				   the rule, and it is the one `clock()` prints on every block. */
				shown: String(h12),
				now: h12,
				max: 12,
				// An hour of real time, so stepping up from 11 AM reaches noon rather
				// than wrapping inside the half of the day the reader is in.
				bump: (d) => set(value + d * 60),
				digits: hourDigits,
				right: minRef
			})}
			<span className="tfcolon">:</span>
			{digitSegment('m', {
				ref: minRef,
				shown: pad(min),
				now: min,
				max: 59,
				// Stepping the minute past an hour boundary wraps inside the hour
				// rather than carrying: the reader stepping minutes is not asking to
				// change the hour, and the hour is one key away.
				bump: (d) => setMin((((min + d * step) % 60) + 60) % 60),
				digits: minDigits,
				left: hourRef,
				right: apRef
			})}
			<span
				ref={apRef}
				className="tfseg tfap"
				role="spinbutton"
				tabIndex={0}
				aria-label={`${ariaLabel} meridiem`}
				aria-valuenow={pm ? 1 : 0}
				aria-valuemin={0}
				aria-valuemax={1}
				aria-valuetext={pm ? 'PM' : 'AM'}
				onFocus={() => setTyped('')}
				onKeyDown={(e) => {
					if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
						// Two states, so both arrows are the same instruction: swap.
						e.preventDefault();
						setPm(!pm);
					} else if (/^[aApP]$/.test(e.key)) {
						e.preventDefault();
						setPm(/[pP]/.test(e.key));
					} else if (e.key === 'ArrowLeft') {
						e.preventDefault();
						minRef.current?.focus();
					}
				}}
			>
				{pm ? 'PM' : 'AM'}
			</span>
		</div>
	);
}
