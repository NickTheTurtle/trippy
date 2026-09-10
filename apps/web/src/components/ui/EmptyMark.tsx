/**
 * The drawing an empty list shows above its caption: a fly on a long, aimless
 * S of a flight path.
 *
 * Empty is not an error, and the app spends the rest of its time being useful
 * and quiet, so the one screen with nothing on it is the one place it can
 * afford a joke. A fly with no idea where it is going is the honest picture of
 * a trip nobody has added anything to yet.
 *
 * Drawn from above as clipart rather than as an insect: one round body, two big
 * eyes, two big wings, six bent legs. An anatomically fussier fly at this size
 * turns into a grey smudge, and the point is the joke, not the species.
 *
 * Inline SVG on `currentColor`, the way the other icons here work, so there is
 * no asset to load and no icon dependency. Nothing behind it: a filled tile
 * under the drawing turned it back into a large button that cannot be pressed.
 *
 * The body and eyes are filled with the surface colour, and the wings are drawn
 * over them: translucent, the way a wing at rest actually sits on a fly. Behind
 * the body they read as two detached leaves. Every panel that shows this sits
 * on a card, so the fill matches what is underneath.
 *
 * The trail is dashed and dimmed so the fly is what the eye lands on. Drawn at
 * one weight they read as a single object competing with itself.
 */
export default function EmptyMark() {
	return (
		<svg
			viewBox="0 0 200 130"
			width="280"
			height="182"
			className="text-ink-faint"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{/*
			 * The S: along the floor going nowhere, doubling back, then up. It
			 * ends at the centre of the body rather than short of it, so the
			 * trail reads as coming out of the fly. The filled body hides the
			 * last of it.
			 */}
			<path
				d="M18 112C86 112 98 80 60 73 22 66 30 32 126 34"
				strokeWidth="2"
				strokeDasharray="1 9"
				opacity="0.55"
			/>
			{/* Tilted, because a level fly looks parked. */}
			<g transform="translate(126 34) rotate(-12)" strokeWidth="1.6">
				<path d="M-11 -7l-6-5-4 1M-3 -12.5l-3-7-4-2M5 -12l3-6 4-1M-11 7l-6 5-4-1M-3 12.5l-3 7-4 2M5 12l3 6 4 1" />
				<circle cx="0" cy="0" r="13" fill="var(--color-surface)" />
				<circle cx="12.5" cy="-6.5" r="6.8" fill="var(--color-surface)" />
				<circle cx="12.5" cy="6.5" r="6.8" fill="var(--color-surface)" />
				<circle cx="14.5" cy="-7.5" r="2.1" fill="currentColor" stroke="none" />
				<circle cx="14.5" cy="7.5" r="2.1" fill="currentColor" stroke="none" />
				<path
					d="M2 -4C-8 -22 -24 -32 -31 -27 -38 -22 -20 -10 -1 -5Z"
					fill="var(--color-surface)"
					fillOpacity="0.72"
					opacity="0.75"
				/>
				<path
					d="M2 4C-8 22-24 32-31 27-38 22-20 10-1 5Z"
					fill="var(--color-surface)"
					fillOpacity="0.72"
					opacity="0.75"
				/>
			</g>
		</svg>
	);
}
