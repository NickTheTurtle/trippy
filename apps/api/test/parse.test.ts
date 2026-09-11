import { describe, expect, it } from 'vitest';
import {
	bool,
	body,
	int,
	isoDay,
	num,
	optStr,
	rawStr,
	record,
	str,
	strList
} from '../src/parse.ts';

/**
 * The readers every request body goes through.
 *
 * These are the only thing between a JSON body and the persistence layer, and a
 * JSON body can carry any shape at all: a number where a name belongs, an array
 * where a map belongs, `null` anywhere. The cases below are written from the
 * attacker's side rather than the form's, because the form is already known to
 * work and the point of these functions is everything the form would never send.
 */

describe('str and rawStr', () => {
	it('trims a string', () => {
		expect(str('  Kyoto  ')).toBe('Kyoto');
		expect(str('')).toBe('');
	});

	it('refuses to coerce a non-string into one', () => {
		// The reason this matters: String(x) on an object gives "[object
		// Object]", which is a perfectly valid trip name as far as SQLite is
		// concerned. Returning '' instead lets the caller's own required-field
		// check reject it.
		expect(str({ toString: () => 'Kyoto' })).toBe('');
		expect(str(['Kyoto'])).toBe('');
		expect(str(42)).toBe('');
		expect(str(null)).toBe('');
		expect(str(undefined)).toBe('');
		expect(str(true)).toBe('');
	});

	it('strips only whitespace, leaving the rest of the value alone', () => {
		expect(str('\t \n Kyoto \r\n')).toBe('Kyoto');
		expect(str('  Kyoto  in  Spring  ')).toBe('Kyoto  in  Spring');
	});

	it('keeps surrounding whitespace when the value is a password', () => {
		// A space at either end of a password is a character of it. Trimming it
		// locks out the account that chose it, and does so only at sign-in.
		expect(rawStr(' hunter2 ')).toBe(' hunter2 ');
		expect(rawStr('   ')).toBe('   ');
		expect(rawStr(42)).toBe('');
	});
});

describe('optStr', () => {
	it('turns absent, empty and whitespace-only into null', () => {
		expect(optStr(undefined)).toBeNull();
		expect(optStr(null)).toBeNull();
		expect(optStr('')).toBeNull();
		expect(optStr('   ')).toBeNull();
		expect(optStr({})).toBeNull();
	});

	it('returns a trimmed value when there is one', () => {
		expect(optStr('  note  ')).toBe('note');
	});
});

describe('num and int', () => {
	it('accepts numbers and the numeric strings a form input gives', () => {
		expect(num(12.5)).toBe(12.5);
		expect(num('12.5')).toBe(12.5);
		expect(num(' 12.5 ')).toBe(12.5);
		expect(num('-3')).toBe(-3);
		expect(num(0)).toBe(0);
		expect(num('0')).toBe(0);
	});

	it('rejects everything that is not a finite number', () => {
		expect(num(Number.NaN)).toBeNull();
		expect(num(Number.POSITIVE_INFINITY)).toBeNull();
		expect(num('Infinity')).toBeNull();
		expect(num('NaN')).toBeNull();
		expect(num('')).toBeNull();
		expect(num('   ')).toBeNull();
		expect(num('12abc')).toBeNull();
		expect(num('1_000')).toBeNull();
		expect(num(null)).toBeNull();
		expect(num(undefined)).toBeNull();
		expect(num(true)).toBeNull();
		expect(num([])).toBeNull();
		expect(num([5])).toBeNull();
		expect(num({})).toBeNull();
	});

	it('rejects a fractional count rather than rounding it', () => {
		// Money in minor units, pixel widths and minute offsets are all counts.
		// Half a cent is a bad request, and rounding it would silently change
		// the amount the sender believes they recorded.
		expect(int(1.5)).toBeNull();
		expect(int('1.5')).toBeNull();
		expect(int(1.0)).toBe(1);
		expect(int('1.0')).toBe(1);
		expect(int(-7)).toBe(-7);
	});

	it('passes a very large count through unchanged rather than mangling it', () => {
		// Past the safe integer range a number is no longer the count it was
		// written as, so callers clamp. What is pinned here is that the parser
		// does not quietly round or truncate on the way.
		expect(int(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
		expect(int('1e21')).toBe(1e21);
	});
});

describe('bool', () => {
	it('distinguishes false from absent', () => {
		// An absent `done` on a task means "flip whatever is there", which is a
		// different request from `false`. Coercing with !! loses that.
		expect(bool(true)).toBe(true);
		expect(bool(false)).toBe(false);
		expect(bool(undefined)).toBeNull();
		expect(bool(null)).toBeNull();
	});

	it('accepts the two strings a query parameter can carry, and nothing else', () => {
		expect(bool('true')).toBe(true);
		expect(bool('false')).toBe(false);
		expect(bool('TRUE')).toBeNull();
		expect(bool(' true')).toBeNull();
		expect(bool('1')).toBeNull();
		expect(bool(1)).toBeNull();
		expect(bool(0)).toBeNull();
		expect(bool('yes')).toBeNull();
	});
});

describe('isoDay', () => {
	it('accepts a real calendar day', () => {
		expect(isoDay('2026-03-14')).toBe('2026-03-14');
		expect(isoDay('  2026-03-14  ')).toBe('2026-03-14');
		expect(isoDay('2024-02-29')).toBe('2024-02-29');
	});

	it('rejects a day that looks right but does not exist', () => {
		// The regex alone cannot catch these: Date rolls them over silently, so
		// 2023-02-29 would be stored as the 1st of March without complaint.
		expect(isoDay('2023-02-29')).toBeNull();
		expect(isoDay('2026-02-30')).toBeNull();
		expect(isoDay('2026-13-01')).toBeNull();
		expect(isoDay('2026-00-10')).toBeNull();
		expect(isoDay('2026-04-31')).toBeNull();
		expect(isoDay('2026-01-00')).toBeNull();
	});

	it('rejects anything that is not exactly YYYY-MM-DD', () => {
		expect(isoDay('2026-3-14')).toBeNull();
		expect(isoDay('26-03-14')).toBeNull();
		expect(isoDay('2026/03/14')).toBeNull();
		expect(isoDay('2026-03-14T00:00:00Z')).toBeNull();
		expect(isoDay('')).toBeNull();
		expect(isoDay(null)).toBeNull();
		expect(isoDay(20260314)).toBeNull();
		expect(isoDay(new Date('2026-03-14'))).toBeNull();
	});

	it('rejects a two-digit year that Date would quietly move to the 1900s', () => {
		expect(isoDay('0026-03-14')).toBeNull();
		expect(isoDay('0099-03-14')).toBeNull();
	});
});

describe('record', () => {
	it('accepts a plain object of untrusted values', () => {
		expect(record({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
		expect(record({})).toEqual({});
	});

	it('rejects the shapes that would be indexed into as though they were maps', () => {
		// A per-user weights map arriving as an array would still answer to
		// weights['0'], which is not the user the caller asked about.
		expect(record([1, 2, 3])).toEqual({});
		expect(record('weights')).toEqual({});
		expect(record(null)).toEqual({});
		expect(record(undefined)).toEqual({});
		expect(record(7)).toEqual({});
	});

	it('does not let an inherited property answer for a missing key', () => {
		// Ids come from the database, so this is defence in depth rather than a
		// live hole: a lookup for a key that is not present has to read as
		// absent even when Object.prototype has something by that name.
		const weights = record(JSON.parse('{"real":"5"}'));
		expect(num(weights['constructor'])).toBeNull();
		expect(num(weights['toString'])).toBeNull();
		expect(num(weights['__proto__'])).toBeNull();
		expect(num(weights['real'])).toBe(5);
	});

	it('does not pollute Object.prototype through a __proto__ key', () => {
		const parsed = record(JSON.parse('{"__proto__":{"polluted":"yes"}}'));
		expect(parsed).toBeDefined();
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});
});

describe('strList', () => {
	it('accepts an array of ids', () => {
		expect(strList(['a', 'b'])).toEqual(['a', 'b']);
	});

	it('accepts the comma-joined form as well', () => {
		expect(strList('a,b,c')).toEqual(['a', 'b', 'c']);
		expect(strList(' a , b ')).toEqual(['a', 'b']);
	});

	it('drops empties rather than producing a blank id', () => {
		expect(strList('a,,b')).toEqual(['a', 'b']);
		expect(strList(',')).toEqual([]);
		expect(strList(['a', '', '   ', 'b'])).toEqual(['a', 'b']);
	});

	it('drops non-string entries instead of coercing them', () => {
		expect(strList([1, 2, null, { id: 'x' }, ['y']])).toEqual([]);
		expect(strList([1, 'keep'])).toEqual(['keep']);
	});

	it('returns an empty list for anything that is neither a list nor a string', () => {
		expect(strList(null)).toEqual([]);
		expect(strList(undefined)).toEqual([]);
		expect(strList({ 0: 'a', length: 1 })).toEqual([]);
	});
});

describe('body', () => {
	it('reads a JSON object', async () => {
		expect(await body({ req: { json: async () => ({ name: 'Kyoto' }) } })).toEqual({
			name: 'Kyoto'
		});
	});

	it('gives an empty object rather than throwing on malformed JSON', async () => {
		// An unparseable body is a 400 from the route's own required-field
		// check, not a 500 from the parser.
		expect(
			await body({
				req: {
					json: async () => {
						throw new SyntaxError('Unexpected token');
					}
				}
			})
		).toEqual({});
	});

	it('gives an empty object for a body that is valid JSON but not an object', async () => {
		expect(await body({ req: { json: async () => [1, 2] } })).toEqual({});
		expect(await body({ req: { json: async () => 'hello' } })).toEqual({});
		expect(await body({ req: { json: async () => null } })).toEqual({});
	});
});
