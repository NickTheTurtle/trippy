import { describe, expect, it } from 'vitest';
import { isItemType, isPoiKind, poiKindFromCategory, toPoiKind } from '@trippy/core/types';

describe('item types', () => {
	it('accepts only canonical schedule item types', () => {
		expect(isItemType('poi')).toBe(true);
		expect(isItemType('food')).toBe(true);
		expect(isItemType('meal')).toBe(false);
	});
});

describe('poi kinds', () => {
	it('accepts only stored POI kinds', () => {
		expect(isPoiKind('attraction')).toBe(true);
		expect(isPoiKind('food')).toBe(true);
		expect(isPoiKind('lodging')).toBe(false);
	});

	it('classifies known food categories and defaults everything else to attractions', () => {
		expect(poiKindFromCategory(' Nightlife ')).toBe('food');
		expect(poiKindFromCategory('café')).toBe('food');
		expect(poiKindFromCategory('museum')).toBe('attraction');
		expect(poiKindFromCategory(null)).toBe('attraction');
	});

	it('coerces unknown input to attraction', () => {
		expect(toPoiKind('food')).toBe('food');
		expect(toPoiKind('lodging')).toBe('attraction');
		expect(toPoiKind(42)).toBe('attraction');
	});
});
