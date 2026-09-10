import { PlusIcon } from './card-controls';
import { copy } from '../../copy';

const c = copy.discover.noCities;

/**
 * Discover's first-run panel: the trip has no cities yet.
 *
 * This is a whole page, not a hole in one, which is why it does not use
 * `EmptyState`. That component is deliberately a bare left-aligned line for use
 * inside a `.card` or a grid cell, where a second box would read as a broken
 * layout; used as the only thing on a wide page it left one grey sentence
 * floating in the corner. Here the box is the point, so this panel is its own
 * piece rather than a variant that would have to opt out of everything
 * `EmptyState` is. The six in-card callers are untouched.
 *
 * Both roles get an honest answer. Adding a city is organizer-only on the
 * server, so a member gets no button rather than a disabled one.
 *
 * The button is the page's single call to action, and carries the same plus as
 * the sidebar's "Add city" so the two ways in read as one action.
 */
export default function NoCities({
	isOrganizer,
	onAddCity
}: {
	isOrganizer: boolean;
	/** Opens the add-city dialog, the one place cities are added. */
	onAddCity: () => void;
}) {
	return (
		<div className="card mx-auto flex w-full max-w-[34rem] flex-col items-start gap-3 p-8">
			<PinMark />
			<h2 className="m-0 text-[1.35rem]">{c.heading}</h2>
			<p className="muted m-0">{c.body}</p>
			{isOrganizer ? (
				<button type="button" className="btn primary mt-1" onClick={onAddCity}>
					<PlusIcon />
					{c.cta}
				</button>
			) : (
				<p className="m-0 text-[0.84rem] text-ink-faint">{c.memberNote}</p>
			)}
		</div>
	);
}

/**
 * A map pin in a soft accent tile. Inline SVG on `currentColor`, the way the
 * rest of Discover draws its icons: no dependency, no asset. The tile is sized
 * from `--control-h` rather than a new number, so it lines up with the button
 * below it.
 */
function PinMark() {
	return (
		<span
			aria-hidden="true"
			className="mb-1 inline-flex size-[var(--control-h)] items-center justify-center rounded-md bg-accent-soft text-accent-ink"
		>
			<svg viewBox="0 0 16 16" className="size-5">
				<path
					d="M8 14.2c2.6-3.1 4.1-5.3 4.1-7.1a4.1 4.1 0 1 0-8.2 0c0 1.8 1.5 4 4.1 7.1z"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinejoin="round"
				/>
				<circle cx="8" cy="7" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
			</svg>
		</span>
	);
}
