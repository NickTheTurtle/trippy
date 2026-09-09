import { describe, expect, it } from 'vitest';
import { coverArt, photoSrc } from '@trippy/core/cover';

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
});

describe('photoSrc', () => {
	it('proxies Google place photo resource names with the requested width', () => {
		expect(photoSrc('places/abc def/photos/ghi', 320)).toBe('/api/place-photo?name=places%2Fabc%20def%2Fphotos%2Fghi&w=320');
	});

	it('passes through absolute http URLs and rejects missing or relative values', () => {
		expect(photoSrc('https://example.test/photo.jpg')).toBe('https://example.test/photo.jpg');
		expect(photoSrc('http://example.test/photo.jpg')).toBe('http://example.test/photo.jpg');
		expect(photoSrc('/local/photo.jpg')).toBeNull();
		expect(photoSrc(null)).toBeNull();
	});
});
