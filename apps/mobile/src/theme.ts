import { Platform } from 'react-native';

/**
 * The web app's palette, restated for React Native.
 *
 * These values intentionally stay tied to apps/web/src/styles/index.css and to
 * the first native pass, so the redesign changes the iOS surface language
 * without turning Trippy into a different product.
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

export const radius = {
	icon: 8,
	section: 12,
	button: 10,
	hero: 18,
	sheet: 22,
	// Compatibility aliases for older screens during the rollout.
	sm: 6,
	md: 10,
	lg: 16
} as const;

export const controlHeight = 44;
/**
 * The native navigation bar's height below the status bar. Screens drawn under a
 * transparent header (Register, Forgot) start their content this far down, plus
 * the safe-area top, because iOS does not inset their ScrollView on its own.
 */
export const navBarHeight = Platform.OS === 'android' ? 56 : 44;
export const rowHeight = 52;
export const screenMargin = 16;
/**
 * Grouped-list geometry, the iOS inset-grouped numbers. Every row inside a
 * section card starts its content `rowInset` from the card's edge, the section
 * header above the card starts at the same x, and the hairline between rows
 * starts where the row's text does. `rowPadY` is what lets a two- or three-line
 * row breathe: the minimum height alone centres one line and leaves a taller
 * row touching the card's edges.
 */
export const rowInset = 16;
export const rowPadY = 11;
export const rowMinHeight = 44;
/** Space between blocks on a screen: sections, segmented controls, cards. */
export const blockGap = 24;
/**
 * The right margin a custom header button needs. On iOS and Android the native
 * stack's bar already insets its items; on web the stack falls back to a
 * JavaScript header that puts them flush against the screen edge.
 */
export const headerEdge = Platform.OS === 'web' ? screenMargin : 0;
/**
 * The bar behind a native large title. On iOS 26 it has to stay transparent: a
 * background colour makes the large title invisible there (the router's own
 * default says so), the system's scroll edge effect keeps the collapsed bar
 * legible, and the screen already paints the page colour behind it. Before 26
 * there is no edge effect, so a transparent collapsed bar would let rows slide
 * under its title unreadably; there, and off iOS, it is the page colour.
 */
const iosMajor = Platform.OS === 'ios' ? parseInt(String(Platform.Version), 10) : 0;
export const largeTitleHeaderStyle = {
	backgroundColor: iosMajor >= 26 ? 'transparent' : color.bg
};
export const hairline = Platform.select({ web: 1, default: 0.5 }) ?? 0.5;

export const space = {
	xs: 4,
	sm: 8,
	md: 12,
	lg: 16,
	xl: 24,
	xxl: 32,
	sectionGap: 18
} as const;

/**
 * Display type is the web's: Fraunces, the serif every web heading (h1 to h3)
 * is set in, loaded at the root from @expo-google-fonts. It is what makes the
 * phone read as the same product as web mobile, so it carries the titles a
 * reader lands on: large titles, the trip's name, trip card names, a day's
 * date, first-run headings. Place card names stay sans, as the web sets them. Rows, fields, tabs and sheets keep the
 * system font, so the working surface still reads as native iOS. The web sets
 * headings at weight 560; SemiBold (600) is the nearest shipped cut.
 */
export const serif = 'Fraunces_600SemiBold';
export const font = {
	heading: { fontFamily: serif },
	body: {}
};

export const iosType = {
	largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' as const, color: color.ink },
	title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, color: color.ink },
	title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' as const, color: color.ink },
	headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const, color: color.ink },
	body: { fontSize: 17, lineHeight: 22, color: color.ink },
	callout: { fontSize: 16, lineHeight: 21, color: color.ink },
	subhead: { fontSize: 15, lineHeight: 20, color: color.inkSoft },
	footnote: { fontSize: 13, lineHeight: 18, color: color.inkSoft },
	caption: { fontSize: 12, lineHeight: 16, color: color.inkFaint, fontWeight: '600' as const }
} as const;

/**
 * The serif scale. No fontWeight: the weight is in the family name, and asking
 * iOS to embolden a custom face again either does nothing or fakes a bolder cut.
 */
export const displayType = {
	largeTitle: { fontFamily: serif, fontSize: 34, lineHeight: 41, color: color.ink },
	title2: { fontFamily: serif, fontSize: 24, lineHeight: 29, color: color.ink },
	title3: { fontFamily: serif, fontSize: 20, lineHeight: 25, color: color.ink },
	headline: { fontFamily: serif, fontSize: 18, lineHeight: 23, color: color.ink }
} as const;

export const type = {
	largeTitle: iosType.largeTitle,
	title: iosType.largeTitle,
	title2: iosType.title2,
	title3: iosType.title3,
	head: iosType.headline,
	body: iosType.body,
	callout: iosType.callout,
	subhead: iosType.subhead,
	small: iosType.subhead,
	footnote: iosType.footnote,
	faint: { ...iosType.footnote, color: color.inkFaint },
	caption: iosType.caption
} as const;

export const fieldLabel = {
	...iosType.footnote,
	color: color.inkFaint,
	fontWeight: '600' as const
} as const;

export const card = {
	backgroundColor: color.surface,
	borderRadius: radius.section
} as const;
