import { useEffect, useState } from 'react';
import { coverArt, photoSrc } from '@trippy/core/cover';

/**
 * Shared cover image for place and stay cards.
 *
 * Prefers the place's real photograph, the storefront-style picture Google Maps
 * shows, and falls back to deterministic generated art when there is none. A
 * photo that fails at runtime (Google photo references expire) falls back too,
 * so a card never shows a broken image.
 */
export default function Cover({
	photo = null,
	seed,
	category = null,
	height = '128px',
	background,
	children
}: {
	photo?: string | null;
	seed: string;
	category?: string | null;
	height?: string;
	/** Overrides the generated art, for callers that already have their own. */
	background?: string;
	children?: React.ReactNode;
}) {
	const art = coverArt(seed, category);
	const url = photoSrc(photo);
	const [failed, setFailed] = useState(false);

	// A new photo deserves a fresh attempt even if the previous one failed.
	useEffect(() => setFailed(false), [url]);

	return (
		<div className="cover" style={{ height, background: background ?? art.background }}>
			{url && !failed ? (
				<img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
			) : (
				!background && (
					<span className="glyph" aria-hidden="true">
						{art.glyph}
					</span>
				)
			)}
			{children}
		</div>
	);
}
