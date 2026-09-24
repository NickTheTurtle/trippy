import { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { coverArt, photoSrc } from '@trippy/core/cover';
import { API_BASE } from '../../lib/api';
import { getToken } from '../../lib/token';
import { color, radius } from '../../theme';

function firstColour(background: string): string {
	return background.match(/#[0-9a-f]{6}/i)?.[0] ?? color.surface2;
}

export function CoverImage({
	photo,
	seed,
	category,
	height = 116
}: {
	photo?: string | null;
	seed: string;
	category?: string | null;
	height?: number;
}) {
	const art = coverArt(seed, category);
	const src = photoSrc(photo, 320);
	const [failed, setFailed] = useState(false);
	const [token, setToken] = useState<string | null>(null);

	useEffect(() => {
		setFailed(false);
		void getToken().then(setToken);
	}, [src]);

	const uri = src?.startsWith('/api/') ? `${API_BASE}${src}` : src;
	return (
		<View
			style={{
				height,
				borderRadius: radius.lg,
				overflow: 'hidden',
				backgroundColor: firstColour(art.background),
				alignItems: 'center',
				justifyContent: 'center'
			}}
		>
			{uri && !failed ? (
				<Image
					source={{
						uri,
						headers: token
							? { authorization: `Bearer ${token}`, 'x-trippy-client': 'native' }
							: undefined
					}}
					onError={() => setFailed(true)}
					style={{ width: '100%', height: '100%' }}
					resizeMode="cover"
				/>
			) : (
				<Text style={{ fontSize: 34 }}>{art.glyph}</Text>
			)}
		</View>
	);
}
