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
	const src = photoSrc(photo);
	const proxied = !!src?.startsWith('/api/');
	const [failed, setFailed] = useState(false);
	const [token, setToken] = useState<string | null | undefined>(undefined);

	useEffect(() => {
		setFailed(false);
		setToken(undefined);
		void getToken().then(setToken);
	}, [src]);

	const uri = proxied ? `${API_BASE}${src}` : src;
	const canLoad = uri && !failed && (!proxied || token !== undefined);
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
			{canLoad ? (
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
				/>
			) : (
				<Text style={{ fontSize: 34 }}>{art.glyph}</Text>
			)}
		</View>
	);
}
