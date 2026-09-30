import { describe, expect, it } from 'vitest';
import {
	coverArt,
	coverGlyph,
	coverGradient,
	parseCoverGradient,
	photoSrc
} from '@trippy/core/cover';

describe('coverArt', () => {
	it('is deterministic for the same seed and category', () => {
		expect(coverArt('Forbidden City', 'history')).toEqual(coverArt('Forbidden City', 'history'));
	});

	it('normalizes category names before choosing a glyph', () => {
		expect(coverArt('Blue Bottle', ' Cafe ').glyph).toBe('☕');
		expect(coverArt('No category', null).glyph).toBe('📍');
	});

	it('uses the place fallback seed for empty seeds', () => {
		expect(coverArt('', 'park').background).toBe(coverArt('place', 'park').background);
	});

	it('draws the same gradient the parts describe', () => {
		const { from, to, angle } = coverGradient('Forbidden City');
		expect(coverArt('Forbidden City', 'history').background).toBe(
			`linear-gradient(${angle}deg, ${from}, ${to})`
		);
		expect(coverGlyph(' Cafe ')).toBe('☕');
	});
});

describe('parseCoverGradient', () => {
	it('reads a stored two-stop gradient into parts', () => {
		expect(parseCoverGradient('linear-gradient(135deg, #2f6d5e, #7ba697)')).toEqual({
			angle: 135,
			from: '#2f6d5e',
			to: '#7ba697'
		});
	});

	it('round-trips the generated place gradient', () => {
		const parts = coverGradient('Blue Bottle');
		expect(parseCoverGradient(coverArt('Blue Bottle').background)).toEqual(parts);
	});

	it('refuses anything that is not a plain two-stop gradient', () => {
		expect(parseCoverGradient('url(evil)')).toBeNull();
		expect(parseCoverGradient('linear-gradient(to right, #fff, #000)')).toBeNull();
		expect(parseCoverGradient(null)).toBeNull();
	});
});

describe('photoSrc', () => {
	it('proxies Google place photo resource names with the requested width', () => {
		expect(photoSrc('places/abc def/photos/ghi', 320)).toBe(
			'/api/place-photo?name=places%2Fabc%20def%2Fphotos%2Fghi&w=320'
		);
	});

	it('passes through absolute http URLs and rejects missing or relative values', () => {
		expect(photoSrc('https://example.test/photo.jpg')).toBe('https://example.test/photo.jpg');
		expect(photoSrc('http://example.test/photo.jpg')).toBe('http://example.test/photo.jpg');
		expect(photoSrc('/local/photo.jpg')).toBeNull();
		expect(photoSrc(null)).toBeNull();
	});
});
