import { describe, expect, it } from 'vitest';
import { copy } from '@trippy/copy';
import { viewAsAccessibilityLabel, viewAsButtonLabel, viewAsChoices } from '../src/lib/viewAs';

const members = [
	{ id: 'me', name: 'Demo Traveller' },
	{ id: 'j', name: 'Jordan Lee' },
	{ id: 'p', name: 'Priya' }
];

describe('viewAsChoices', () => {
	it('lists everyone first, then each member, with you marked', () => {
		expect(viewAsChoices(members, 'me')).toEqual([
			{ key: '', label: copy.viewAs.everyone },
			{ key: 'me', label: 'Demo Traveller (you)' },
			{ key: 'j', label: 'Jordan Lee' },
			{ key: 'p', label: 'Priya' }
		]);
	});
});

describe('viewAsButtonLabel', () => {
	it('says Everyone for no one in particular', () => {
		expect(viewAsButtonLabel('', members, 'me')).toBe(copy.viewAs.everyone);
	});

	it('says You for yourself', () => {
		expect(viewAsButtonLabel('me', members, 'me')).toBe(copy.viewAs.you);
	});

	it('uses a first name for anyone else', () => {
		expect(viewAsButtonLabel('j', members, 'me')).toBe('Jordan');
		expect(viewAsButtonLabel('p', members, 'me')).toBe('Priya');
	});

	it('falls back to Everyone for someone no longer on the trip', () => {
		expect(viewAsButtonLabel('gone', members, 'me')).toBe(copy.viewAs.everyone);
	});
});

describe('viewAsAccessibilityLabel', () => {
	it('names the full choice, you included', () => {
		expect(viewAsAccessibilityLabel('me', members, 'me')).toBe(
			copy.viewAs.buttonLabel('Demo Traveller (you)')
		);
		expect(viewAsAccessibilityLabel('j', members, 'me')).toBe(
			copy.viewAs.buttonLabel('Jordan Lee')
		);
		expect(viewAsAccessibilityLabel('', members, 'me')).toBe(
			copy.viewAs.buttonLabel(copy.viewAs.everyone)
		);
	});
});
