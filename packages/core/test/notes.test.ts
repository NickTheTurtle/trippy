import { describe, expect, it } from 'vitest';
import {
	MAX_NOTES_BODY,
	editedAgo,
	isNotesBodyLength,
	mergeNotes,
	notesBodyTooLong,
	rebaseEdit
} from '../src/notes';

/**
 * The shared notepad's merge, run by a client whose save came back 409: `base`
 * is what it loaded, `ours` what was typed since, `theirs` what the server
 * holds now. The rule under test throughout is that nobody's typing is lost.
 */
describe('mergeNotes', () => {
	it('returns the shared text when nothing changed', () => {
		expect(mergeNotes('a\nb\n', 'a\nb\n', 'a\nb\n')).toBe('a\nb\n');
	});

	it('takes the one side that changed', () => {
		expect(mergeNotes('a\nb', 'a\nB', 'a\nb')).toBe('a\nB');
		expect(mergeNotes('a\nb', 'a\nb', 'a\nB')).toBe('a\nB');
	});

	it('applies an identical change once', () => {
		expect(mergeNotes('a\nb\nc', 'a\nB\nc', 'a\nB\nc')).toBe('a\nB\nc');
	});

	it('applies an identical change once even beside a change of one side', () => {
		// Both rewrote line 2 the same way; only theirs also touched line 4.
		expect(mergeNotes('1\n2\n3\n4', '1\nTWO\n3\n4', '1\nTWO\n3\nFOUR')).toBe('1\nTWO\n3\nFOUR');
	});

	it('keeps both when both append, ours first', () => {
		expect(mergeNotes('a\n', 'a\nfrom ours\n', 'a\nfrom theirs\n')).toBe(
			'a\nfrom ours\nfrom theirs\n'
		);
	});

	it('keeps both appends when the base has no trailing newline', () => {
		expect(mergeNotes('a', 'a\nours', 'a\ntheirs')).toBe('a\nours\ntheirs');
	});

	it('applies edits in separate places', () => {
		const base = 'flights\nhotel\ncar\ninsurance\nvisa';
		const ours = 'flights booked\nhotel\ncar\ninsurance\nvisa';
		const theirs = 'flights\nhotel\ncar\ninsurance\nvisa done';
		expect(mergeNotes(base, ours, theirs)).toBe('flights booked\nhotel\ncar\ninsurance\nvisa done');
	});

	it('applies edits to neighbouring lines without a conflict', () => {
		expect(mergeNotes('x\ny', 'X\ny', 'x\nY')).toBe('X\nY');
	});

	it('applies an insertion beside the other side edit', () => {
		// Theirs edits line 2; ours adds a line in front of it.
		expect(mergeNotes('a\nb\nc', 'a\nnew\nb\nc', 'a\nB\nc')).toBe('a\nnew\nB\nc');
		// And after it.
		expect(mergeNotes('a\nb\nc', 'a\nb\nnew\nc', 'a\nB\nc')).toBe('a\nB\nnew\nc');
	});

	it('keeps both versions of a line edited differently, ours then theirs', () => {
		expect(mergeNotes('a\nmeet at 9\nc', 'a\nmeet at 10\nc', 'a\nmeet at 9 sharp\nc')).toBe(
			'a\nmeet at 10\nmeet at 9 sharp\nc'
		);
	});

	it('keeps only the longer when one side merely continues the other', () => {
		// A late save of the first half of somebody's typing lands after the save
		// of the whole of it: one line, not two.
		const base = 'Title\nline one\nend';
		const first = 'Title\nLONE ONE\nend';
		const later = 'Title\nLONE ONE TWO\nend';
		expect(mergeNotes(base, first, later)).toBe(later);
		expect(mergeNotes(base, later, first)).toBe(later);
		// Continued onto new lines counts too.
		expect(mergeNotes(base, first, 'Title\nLONE ONE\nTWO\nTHREE\nend')).toBe(
			'Title\nLONE ONE\nTWO\nTHREE\nend'
		);
	});

	it('still keeps both when neither side continues the other', () => {
		expect(mergeNotes('Title\nline one\nend', 'Title\nLONE ONE\nend', 'Title\nLONE TWO\nend')).toBe(
			'Title\nLONE ONE\nLONE TWO\nend'
		);
		// A longer version that does not start with the shorter is not a continuation.
		expect(mergeNotes('x', 'ONE', 'TWO ONE')).toBe('ONE\nTWO ONE');
	});

	it('keeps a deliberate trim visible rather than letting the longer undo it', () => {
		const base = 'List\nBuy milk and eggs\nend';
		expect(mergeNotes(base, 'List\nBuy milk\nend', 'List\nBuy milk and eggs!\nend')).toBe(
			'List\nBuy milk\nBuy milk and eggs!\nend'
		);
		expect(mergeNotes(base, 'List\nBuy milk and eggs!\nend', 'List\nBuy milk\nend')).toBe(
			'List\nBuy milk and eggs!\nBuy milk\nend'
		);
	});

	it('writes no conflict markers', () => {
		const merged = mergeNotes('x', 'ours', 'theirs');
		expect(merged).toBe('ours\ntheirs');
		expect(merged).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
	});

	it('keeps the edited text when the other side deleted the line (ours deleted)', () => {
		expect(mergeNotes('a\nb\nc', 'a\nc', 'a\nB edited\nc')).toBe('a\nB edited\nc');
	});

	it('keeps the edited text when the other side deleted the line (theirs deleted)', () => {
		expect(mergeNotes('a\nb\nc', 'a\nB edited\nc', 'a\nc')).toBe('a\nB edited\nc');
	});

	it('deletes a line one side removed and the other left alone', () => {
		expect(mergeNotes('a\nb\nc', 'a\nc', 'a\nb\nc\nd')).toBe('a\nc\nd');
	});

	it('deletes a line both sides removed', () => {
		expect(mergeNotes('a\nb\nc', 'a\nc', 'a\nc')).toBe('a\nc');
	});

	it('merges from an empty base', () => {
		expect(mergeNotes('', 'ours', '')).toBe('ours');
		expect(mergeNotes('', '', 'theirs')).toBe('theirs');
		expect(mergeNotes('', 'ours', 'theirs')).toBe('ours\ntheirs');
		expect(mergeNotes('', 'ours\n', 'theirs\n')).toBe('ours\ntheirs\n');
		expect(mergeNotes('', 'same', 'same')).toBe('same');
	});

	it('lets both sides empty the notepad', () => {
		expect(mergeNotes('a\nb', '', '')).toBe('');
		expect(mergeNotes('a\nb', '', 'a\nb')).toBe('');
	});

	it('keeps the other side edit when one side emptied the notepad', () => {
		expect(mergeNotes('a\nb', '', 'a\nB')).toBe('B');
	});

	it('treats a trailing newline as a line of its own', () => {
		// Ours only dropped the final newline, theirs only edited the first line.
		expect(mergeNotes('a\nb\n', 'a\nb', 'A\nb\n')).toBe('A\nb');
		// Both added one.
		expect(mergeNotes('a', 'a\n', 'a\n')).toBe('a\n');
	});

	it('never glues two lines together', () => {
		// Ours types on the unterminated last line; theirs adds a line after it.
		expect(mergeNotes('a', 'ab', 'a\nc')).toBe('ab\nc');
	});

	it('writes the shared head and tail of a conflict once', () => {
		// Both rewrote lines 2-3; they agree on the new line 2 and differ on 3.
		expect(mergeNotes('1\n2\n3\n4', '1\nTWO\nthree\n4', '1\nTWO\nTHREE\n4')).toBe(
			'1\nTWO\nthree\nTHREE\n4'
		);
	});

	it('handles Windows line endings as part of the line', () => {
		expect(mergeNotes('a\r\nb\r\n', 'a\r\nb\r\nc\r\n', 'A\r\nb\r\n')).toBe('A\r\nb\r\nc\r\n');
	});

	it('handles a large rewrite past the diff budget without losing text', () => {
		const base = Array.from({ length: 3000 }, (_, k) => `base ${k}`).join('\n');
		const ours = Array.from({ length: 3000 }, (_, k) => `ours ${k}`).join('\n');
		const theirs = Array.from({ length: 3000 }, (_, k) => `theirs ${k}`).join('\n');
		const merged = mergeNotes(base, ours, theirs);
		expect(merged).toBe(`${ours}\n${theirs}`);
	});

	it('loses no added line in a randomised run', () => {
		// A tiny deterministic PRNG, so a failure is reproducible.
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const words = ['a', 'b', 'c', 'd', ''];
		const edit = (lines: string[], tag: string): string[] => {
			const out = [...lines];
			const ops = 1 + rand(4);
			for (let k = 0; k < ops; k++) {
				const at = rand(out.length + 1);
				const op = rand(3);
				if (op === 0) out.splice(at, 0, `${tag}${k}`);
				else if (op === 1 && at < out.length) out[at] = `${tag}${k}`;
				else if (at < out.length) out.splice(at, 1);
			}
			return out;
		};
		for (let run = 0; run < 500; run++) {
			const base = Array.from({ length: rand(8) }, () => words[rand(words.length)]);
			const ours = edit(base, `o${run}-`);
			const theirs = edit(base, `t${run}-`);
			const merged = mergeNotes(base.join('\n'), ours.join('\n'), theirs.join('\n')).split('\n');
			for (const line of [...ours, ...theirs]) {
				if (/^[ot]\d/.test(line)) expect(merged).toContain(line);
			}
			// Swapping the sides changes only the order, never what survives.
			const swapped = mergeNotes(base.join('\n'), theirs.join('\n'), ours.join('\n')).split('\n');
			expect([...swapped].sort()).toEqual([...merged].sort());
		}
	});
});

describe('rebaseEdit', () => {
	// Somebody else's save swapped the box from `previous` to `replaced`
	// (they added sunscreen); then an edit event arrived.
	const previous = 'Packing\nsocks\nadapter';
	const replaced = 'Packing\nsocks\nadapter\nsunscreen';

	it('takes a keystroke made on the replacement as is', () => {
		expect(rebaseEdit(previous, replaced, `${replaced}!`)).toBe(`${replaced}!`);
		expect(rebaseEdit(previous, replaced, 'Packing\nsocks\nadapter\nsunscree')).toBe(
			'Packing\nsocks\nadapter\nsunscree'
		);
	});

	it('merges a keystroke made on the text from before the swap', () => {
		expect(rebaseEdit(previous, replaced, 'Packing\nsocks!\nadapter')).toBe(
			'Packing\nsocks!\nadapter\nsunscreen'
		);
		// A deletion is a keystroke too.
		expect(rebaseEdit(previous, replaced, 'Packing\nsock\nadapter')).toBe(
			'Packing\nsock\nadapter\nsunscreen'
		);
	});

	it('takes a paste made on the replacement as is', () => {
		const pasted = 'Packing\nsocks\nhat\nscarf\ngloves\nadapter\nsunscreen';
		expect(rebaseEdit(previous, replaced, pasted)).toBe(pasted);
	});

	it('merges a paste made on the text from before the swap', () => {
		expect(rebaseEdit(previous, replaced, 'Packing\nsocks\nhat\nscarf\ngloves\nadapter')).toBe(
			'Packing\nsocks\nhat\nscarf\ngloves\nadapter\nsunscreen'
		);
	});

	it('has nothing to rebase when the swap changed nothing', () => {
		expect(rebaseEdit('same', 'same', 'same!')).toBe('same!');
		expect(rebaseEdit('same', 'same', '')).toBe('');
	});

	it('gives a tie to the replacement', () => {
		expect(rebaseEdit('ab', 'ac', 'ad')).toBe('ad');
		expect(rebaseEdit(previous, replaced, replaced)).toBe(replaced);
	});

	it('does not let an echo of the old text undo the swap', () => {
		expect(rebaseEdit(previous, replaced, previous)).toBe(replaced);
	});

	it('keeps both when the keystroke lands on a line the replacement also changed', () => {
		const merged = rebaseEdit('a\nmeet at 9\nc', 'a\nmeet at 10\nc', 'a\nmeet at 9!\nc');
		expect(merged).toBe('a\nmeet at 9!\nmeet at 10\nc');
	});
});

describe('the notepad ceiling', () => {
	it('is twenty thousand characters by string length', () => {
		expect(MAX_NOTES_BODY).toBe(20000);
		expect(isNotesBodyLength('n'.repeat(MAX_NOTES_BODY))).toBe(true);
		expect(isNotesBodyLength('n'.repeat(MAX_NOTES_BODY + 1))).toBe(false);
		expect(isNotesBodyLength('')).toBe(true);
	});

	it('says so with the number grouped', () => {
		expect(notesBodyTooLong()).toBe('Notes can be at most 20,000 characters.');
	});
});

describe('editedAgo', () => {
	// Built with the local-time constructor, so the cases mean the same thing in
	// whatever zone the test machine is in: the date shown is the viewer's own.
	const now = new Date(2026, 9, 19, 15, 30).getTime();
	const MIN = 60_000;

	it('says just now under a minute', () => {
		expect(editedAgo(now, now)).toBe('just now');
		expect(editedAgo(now - 59_999, now)).toBe('just now');
	});

	it('says just now for a time in the future, which is clock skew', () => {
		expect(editedAgo(now + 5 * MIN, now)).toBe('just now');
	});

	it('counts minutes under an hour, rounded down', () => {
		expect(editedAgo(now - MIN, now)).toBe('1 min ago');
		expect(editedAgo(now - 2 * MIN - 59_000, now)).toBe('2 min ago');
		expect(editedAgo(now - 59 * MIN - 59_999, now)).toBe('59 min ago');
	});

	it('counts hours under a day, rounded down', () => {
		expect(editedAgo(now - 60 * MIN, now)).toBe('1 h ago');
		expect(editedAgo(now - 23 * 60 * MIN - 59 * MIN, now)).toBe('23 h ago');
	});

	it('gives the date from a day on', () => {
		expect(editedAgo(now - 24 * 60 * MIN, now)).toBe('Oct 18');
		expect(editedAgo(new Date(2026, 0, 3, 9).getTime(), now)).toBe('Jan 3');
	});

	it('adds the year when it is not this year', () => {
		expect(editedAgo(new Date(2025, 9, 19, 12).getTime(), now)).toBe('Oct 19, 2025');
		expect(editedAgo(new Date(2025, 11, 31, 23).getTime(), new Date(2026, 0, 2).getTime())).toBe(
			'Dec 31, 2025'
		);
	});

	it('spells every month the en-US way', () => {
		const names = Array.from({ length: 12 }, (_, m) =>
			editedAgo(new Date(2026, m, 1, 12).getTime(), new Date(2026, 11, 31, 12).getTime())
		);
		expect(names).toEqual([
			'Jan 1',
			'Feb 1',
			'Mar 1',
			'Apr 1',
			'May 1',
			'Jun 1',
			'Jul 1',
			'Aug 1',
			'Sep 1',
			'Oct 1',
			'Nov 1',
			'Dec 1'
		]);
	});
});
