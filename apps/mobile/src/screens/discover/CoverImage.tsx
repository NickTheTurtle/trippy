import { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { photoSrc } from '@trippy/core/cover';
import { API_BASE } from '../../lib/api';
import { getToken } from '../../lib/token';
import { color, radius } from '../../theme';
import { AppSymbol } from '../../ui/Symbol';

export function CoverImage({
	photo,
	seed,
	category,
	height = 116,
	flush = false
}: {
	photo?: string | null;
	seed: string;
	category?: string | null;
	height?: number;
	flush?: boolean;
}) {
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
				borderRadius: flush ? 0 : radius.lg,
				overflow: 'hidden',
				backgroundColor: color.accentSoft,
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
				<AppSymbol
					name={symbolFor(category)}
					fallback={fallbackFor(category)}
					size={32}
					color={color.accentInk}
				/>
			)}
		</View>
	);
}

function symbolFor(category?: string | null): string {
	const text = (category ?? '').toLowerCase();
	if (text.includes('stay') || text.includes('hotel') || text.includes('lodging'))
		return 'bed.double.fill';
	if (text.includes('food') || text.includes('restaurant') || text.includes('drink'))
		return 'fork.knife';
	return 'mappin.and.ellipse';
}

function fallbackFor(
	category?: string | null
): 'bed-outline' | 'restaurant-outline' | 'location-outline' {
	const text = (category ?? '').toLowerCase();
	if (text.includes('stay') || text.includes('hotel') || text.includes('lodging'))
		return 'bed-outline';
	if (text.includes('food') || text.includes('restaurant') || text.includes('drink'))
		return 'restaurant-outline';
	return 'location-outline';
}
