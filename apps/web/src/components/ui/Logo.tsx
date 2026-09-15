/**
 * The Trippy mark: a tree of choices.
 *
 * A dendrogram laid out horizontally, growing left to right. One root on the
 * left forks into an upper and a lower branch, and the upper branch forks again,
 * so a single origin fans out to three terminals at three heights. That is the
 * product: a trip plan is a tree of choices, and a group that splits can split
 * again. The figure is inherently asymmetric, which is what keeps it from
 * collapsing into the eye that two mirrored arcs kept becoming.
 *
 * Drawn with orthogonal elbows, not curves: straight horizontal and vertical
 * runs land on the pixel grid at small sizes, where diagonals and arcs antialias
 * into grey mush. Orthogonal branching is also the universal language for a tree
 * (file explorers, org charts, git graphs), so it reads as branching at once.
 *
 * A filled node marks every meaningful point: the two forks and the three
 * terminals, plus the root. A node is where a path arrives or divides, the
 * decision points of the plan, so marking all of them says "every stop is a
 * choice". Six nodes only survive when the mark is drawn large, so this full set
 * lives in the header badge and the app-icon PNGs, which always render big. The
 * 16px `favicon.svg` drops to the two junction nodes alone, because at tab size
 * the terminal and root dots shrink below a pixel and turn to mud; that is a
 * deliberate size-specific simplification of the same tree, not a second mark.
 *
 * By default this renders the badge: the same artwork as the favicon, an accent
 * rounded square with the tree knocked out in the page background, so the mark
 * in the browser tab and the mark in the header are one object. The knockout
 * wants a solid field under it anyway, since a bare stroke vanishes on a dark
 * tab. `bare` renders just the tree in `currentColor`, the way the row glyphs in
 * `icons.tsx` work, for anywhere the two-colour badge does not belong; both share
 * the path and node data below rather than drawing the tree twice.
 *
 * The geometry is the 64-unit grid the favicon uses, so the two stay in sync.
 */

const BRANCHES = [
	'M12 32H27', // root stub into the first riser
	'M27 24V48', // first riser: upper branch off the top, lower terminal off the bottom
	'M27 24H38', // upper branch across to the second riser
	'M27 48H50', // lower terminal
	'M38 16V32', // second riser: the two upper terminals
	'M38 16H50', // upper terminal
	'M38 32H50' // upper-mid terminal
];
const NODES: [number, number][] = [
	[27, 32], // first fork, where the root divides
	[38, 24], // second fork, where the upper branch divides again
	[12, 32], // root
	[50, 16], // upper terminal
	[50, 32], // upper-mid terminal
	[50, 48] // lower terminal
];

function Tree({ color }: { color: string }) {
	return (
		<g fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
			{BRANCHES.map((d) => (
				<path key={d} d={d} />
			))}
			{NODES.map(([cx, cy]) => (
				<circle key={`${cx},${cy}`} cx={cx} cy={cy} r="3.2" fill={color} stroke="none" />
			))}
		</g>
	);
}

export default function Logo({ size = 26, bare = false }: { size?: number; bare?: boolean }) {
	return (
		<svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			{!bare && <rect width="64" height="64" rx="14" fill="var(--color-accent)" />}
			<Tree color={bare ? 'currentColor' : 'var(--color-bg)'} />
		</svg>
	);
}
