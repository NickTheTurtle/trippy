import { Text, View } from 'react-native';
import { color } from '../theme';

/**
 * The web's person marks (components/ui/Avatar.tsx and Tag.tsx), shared so
 * Expenses and People stop drawing their own copies at their own sizes.
 */

const AVATAR_TONE = {
	accent: { backgroundColor: color.accentSoft, color: color.accentInk },
	solid: { backgroundColor: color.accent, color: '#fff' },
	muted: { backgroundColor: color.surface2, color: color.inkSoft }
} as const;

/** An initial in a circle. 32pt by default: a row's leading item. */
export function Avatar({
	name,
	tone = 'accent',
	size = 32
}: {
	name: string;
	tone?: keyof typeof AVATAR_TONE;
	size?: number;
}) {
	const t = AVATAR_TONE[tone];
	return (
		<View
			style={{
				width: size,
				height: size,
				borderRadius: size / 2,
				backgroundColor: t.backgroundColor,
				alignItems: 'center',
				justifyContent: 'center'
			}}
		>
			<Text style={{ fontSize: size * 0.42, fontWeight: '600', color: t.color }}>
				{name.trim().slice(0, 1).toUpperCase()}
			</Text>
		</View>
	);
}

const TAG_TONE = {
	accent: {
		solid: [color.accentSoft, color.accentInk],
		outline: [color.accentSoft, color.accentInk]
	},
	neutral: { solid: [color.line, color.inkSoft], outline: [color.line, color.inkFaint] },
	warn: { solid: [color.warnSoft, color.warn], outline: [color.warn, color.warn] }
} as const;

/**
 * A small uppercase status word in a pill (YOU, ORGANIZER, INCOME), the web's
 * Tag. Solid fills the pill; outline draws only its edge. `caps={false}` is the
 * web's plain `chip` (a trip card's role), which keeps the word's own casing.
 */
export function Tag({
	label,
	tone = 'neutral',
	outline = false,
	caps = true
}: {
	label: string;
	tone?: keyof typeof TAG_TONE;
	outline?: boolean;
	caps?: boolean;
}) {
	const [edge, ink] = TAG_TONE[tone][outline ? 'outline' : 'solid'];
	return (
		<View
			style={{
				borderRadius: 999,
				paddingHorizontal: 6,
				paddingVertical: 1,
				backgroundColor: outline ? 'transparent' : edge,
				borderWidth: outline ? 1 : 0,
				borderColor: edge,
				alignSelf: 'center'
			}}
		>
			<Text
				style={
					caps
						? {
								fontSize: 10,
								lineHeight: 14,
								fontWeight: '700',
								letterSpacing: 0.6,
								textTransform: 'uppercase',
								color: ink
							}
						: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: ink }
				}
			>
				{label}
			</Text>
		</View>
	);
}
