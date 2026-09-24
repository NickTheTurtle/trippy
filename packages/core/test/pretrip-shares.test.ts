import { describe, expect, it } from 'vitest';
import { amountFor, isFor, shareOf, totalFor, type ShareCostItem } from '../src/pretrip-shares';

const item = (homeCents: number, people: string[] = []): ShareCostItem => ({
	homeCents,
	people: people.map((id) => ({ id }))
});

describe('pretrip share math', () => {
	it('shares unassigned lines across memberCount and returns 0 when memberCount is 0', () => {
		expect(shareOf(item(1200), 'a', 3)).toBe(400);
		expect(shareOf(item(1200), 'a', 0)).toBe(0);
	});

	it('splits assigned lines among assignees and gives others zero', () => {
		expect(shareOf(item(1200, ['a', 'b']), 'a', 3)).toBe(600);
		expect(shareOf(item(1200, ['a', 'b']), 'b', 3)).toBe(600);
		expect(shareOf(item(1200, ['a', 'b']), 'c', 3)).toBe(0);
		expect(isFor(item(1200, ['a', 'b']), 'c')).toBe(false);
	});

	it('returns the whole line when viewAs is empty', () => {
		expect(amountFor(item(999, ['a']), '', 3)).toBe(999);
	});

	it('rounds shares per row', () => {
		expect(shareOf(item(1000, ['a', 'b', 'c']), 'a', 3)).toBe(333);
		expect(shareOf(item(2000, ['a', 'b', 'c']), 'a', 3)).toBe(667);
	});

	it('totals mixed shared and assigned rows', () => {
		const rows = [item(900), item(1200, ['a', 'b']), item(500, ['c'])];
		expect(totalFor(rows, 'a', 3)).toBe(900);
		expect(totalFor(rows, 'c', 3)).toBe(800);
		expect(totalFor(rows, '', 3)).toBe(2600);
	});

	it('supports isFor filtering', () => {
		expect(isFor(item(1000), 'a')).toBe(true);
		expect(isFor(item(1000, ['b']), 'a')).toBe(false);
		expect(isFor(item(1000, ['a']), 'a')).toBe(true);
	});
});
