/**
 * The web app's design tokens, restated for React Native.
 *
 * The values are copied from apps/web/src/styles/index.css rather than being
 * re-derived, so the two clients are the same product rather than two products
 * that resemble each other. They are copied and not imported because the web
 * side declares them to Tailwind as CSS custom properties, which Native cannot
 * read; if a colour changes there it must change here, which is the cost of
 * having two renderers.
 */
export const color = {
	ink: '#1c2321',
	inkSoft: '#4a5551',
	inkFaint: '#8a938f',
	line: '#e4e6e2',
	surface: '#ffffff',
	surface2: '#f6f5f1',
	bg: '#fbfaf6',
	accent: '#2f6d5e',
	accentSoft: '#e4efe9',
	accentInk: '#1f4c41',
	warn: '#b4682a',
	warnSoft: '#f6e9dd',
	dangerInk: '#a8392f',
	dangerSoft: '#fdecea'
} as const;

export const radius = { sm: 6, md: 10, lg: 16 } as const;

/** One control height, for the same reason the web app has one. */
export const controlHeight = 44;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * The web app pairs a serif for headings with a sans for everything else. Until
 * the fonts are bundled, headings take the platform serif so the contrast still
 * reads; on iOS that is New York, which is close enough to Fraunces in weight
 * and warmth to keep the page recognisable.
 */
export const font = {
	heading: { fontFamily: 'Georgia', fontWeight: '600' as const },
	body: {}
};

export const type = {
	title: { fontSize: 26, lineHeight: 31, color: color.ink, ...font.heading },
	head: { fontSize: 19, lineHeight: 24, color: color.ink, ...font.heading },
	body: { fontSize: 15, lineHeight: 22, color: color.ink },
	small: { fontSize: 13, lineHeight: 18, color: color.inkSoft },
	faint: { fontSize: 13, lineHeight: 18, color: color.inkFaint }
} as const;

export const card = {
	backgroundColor: color.surface,
	borderRadius: radius.lg,
	borderWidth: 1,
	borderColor: color.line
} as const;
