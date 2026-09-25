import { View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { color } from '../theme';

/**
 * The web app's empty-list drawing (apps/web/src/components/ui/EmptyMark.tsx),
 * redrawn for React Native: a fly on a long, aimless S of a flight path.
 *
 * It is the same paths at the same 220pt cap, so an empty list on the phone and
 * on the phone-sized web page read as one product. The web version fills the
 * body and wings with the card colour because it always sits on a card; here the
 * empty state sits on the page background, so the fill is passed in and defaults
 * to that background.
 */
export function EmptyMark({ fill = color.bg }: { fill?: string }) {
	const ink = color.inkFaint;
	return (
		<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			<Svg
				viewBox="0 0 200 130"
				width={220}
				height={143}
				fill="none"
				stroke={ink}
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<Path
					d="M18 112C86 112 98 80 60 73 22 66 30 40 126 36"
					strokeWidth={2}
					strokeDasharray="1 9"
					opacity={0.55}
				/>
				<G transform="translate(126 34) rotate(-12)" strokeWidth={1.6}>
					<Path d="M-11 -7l-6-5-4 1M-3 -12.5l-3-7-4-2M5 -12l3-6 4-1M-11 7l-6 5-4-1M-3 12.5l-3 7-4 2M5 12l3 6 4 1" />
					<Circle cx={0} cy={0} r={13} fill={fill} />
					<Circle cx={12.5} cy={-6.5} r={6.8} fill={fill} />
					<Circle cx={12.5} cy={6.5} r={6.8} fill={fill} />
					<Circle cx={14.5} cy={-7.5} r={2.1} fill={ink} stroke="none" />
					<Circle cx={14.5} cy={7.5} r={2.1} fill={ink} stroke="none" />
					<Path
						d="M2 -4C-8 -22 -24 -32 -31 -27 -38 -22 -20 -10 -1 -5Z"
						fill={fill}
						fillOpacity={0.72}
						opacity={0.75}
					/>
					<Path
						d="M2 4C-8 22-24 32-31 27-38 22-20 10-1 5Z"
						fill={fill}
						fillOpacity={0.72}
						opacity={0.75}
					/>
				</G>
			</Svg>
		</View>
	);
}
