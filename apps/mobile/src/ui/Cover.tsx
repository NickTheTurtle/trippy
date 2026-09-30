import { useEffect, useState, type ReactNode } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Image, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { coverGlyph, coverGradient, photoSrc, type CoverGradient } from '@trippy/core/cover';
import { API_BASE } from '../lib/api';
import { getToken } from '../lib/token';

/**
 * The web's card cover (apps/web/src/components/Cover.tsx), drawn natively.
 *
 * The place's photo when it has one; otherwise the same deterministic art the
 * web draws: one of eight muted two-colour gradients picked from the name, and
 * the category's emoji, faded and desaturated. The first native covers were a
 * flat mint block with a pin on every card, which made a list of fourteen
 * places read as fourteen copies of one card. A photo that fails (Google photo
 * references expire) falls back the same way.
 *
 * `gradient` overrides the generated art for a caller that has its own (a
 * trip's stored cover), and `glyph={false}` drops the emoji over it.
 */
export function Cover({
	photo,
	seed,
	category,
	height,
	gradient,
	glyph = true,
	style,
	children
}: {
	photo?: string | null;
	seed: string;
	category?: string | null;
	height: number;
	gradient?: CoverGradient | null;
	glyph?: boolean;
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
}) {
	const src = photoSrc(photo);
	const proxied = !!src?.startsWith('/api/');
	const [failed, setFailed] = useState(false);
	// The photo proxy wants the session; wait for it rather than firing a
	// request that is certain to be refused and then falling back.
	const [token, setToken] = useState<string | null | undefined>(proxied ? undefined : null);
	useEffect(() => {
		setFailed(false);
		if (!proxied) return;
		setToken(undefined);
		let live = true;
		void getToken().then((value) => live && setToken(value));
		return () => {
			live = false;
		};
	}, [src, proxied]);

	const uri = proxied ? `${API_BASE}${src}` : src;
	const showPhoto = !!uri && !failed && (!proxied || token !== undefined);
	const art = gradient ?? coverGradient(seed);
	// The box's shape bends the angle (see gradientPoints), so it is measured.
	const [aspect, setAspect] = useState(3);
	const onLayout = (e: LayoutChangeEvent) => {
		const { width: w, height: h } = e.nativeEvent.layout;
		if (w > 0 && h > 0 && Math.abs(w / h - aspect) > 0.01) setAspect(w / h);
	};
	const { start, end } = gradientPoints(art.angle, aspect);

	return (
		<View style={[{ height, overflow: 'hidden' }, style]} onLayout={onLayout}>
			<LinearGradient
				colors={[art.from, art.to]}
				start={start}
				end={end}
				style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
			/>
			{showPhoto ? (
				<Image
					source={{
						uri,
						headers:
							proxied && token
								? { authorization: `Bearer ${token}`, 'x-trippy-client': 'native' }
								: undefined
					}}
					onError={() => setFailed(true)}
					style={{ width: '100%', height: '100%' }}
					resizeMode="cover"
					accessibilityIgnoresInvertColors
				/>
			) : glyph ? (
				<View
					style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
					accessibilityElementsHidden
					importantForAccessibility="no-hide-descendants"
				>
					<Text style={{ fontSize: 44, lineHeight: 52, opacity: 0.4 }}>{coverGlyph(category)}</Text>
				</View>
			) : null}
			{children}
		</View>
	);
}

/**
 * A CSS gradient angle (0 points up, 90 right) as the start and end points a
 * native gradient takes, which are fractions of the box's width and height.
 *
 * Fractions squash the angle on a wide box: a 170deg line on a 350x128 card
 * came out about 25deg off vertical instead of 10. So the direction is worked
 * out in points and divided back by the box's shape (`aspect` = width over
 * height), and the line is given the CSS length, the one that makes the end
 * colours land exactly on the corners, so both clients colour the same card
 * alike.
 */
function gradientPoints(angle: number, aspect: number) {
	const rad = (angle * Math.PI) / 180;
	const sin = Math.sin(rad);
	const cos = Math.cos(rad);
	// In units of the box's height: width is `aspect`, height is 1.
	const half = (Math.abs(aspect * sin) + Math.abs(cos)) / 2;
	const dx = (sin * half) / aspect;
	const dy = -cos * half;
	return { start: { x: 0.5 - dx, y: 0.5 - dy }, end: { x: 0.5 + dx, y: 0.5 + dy } };
}
