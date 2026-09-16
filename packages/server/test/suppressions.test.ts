import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The email suppression list, and how an SES bounce or complaint feeds it.
 *
 * This exists to protect the owner's `dxu.info` sending identity: open sign-up
 * mails whatever a stranger typed, so hard bounces and complaints are routine,
 * and AWS suspends an identity that drifts past its bounce or complaint rate.
 * The thing these cases have to pin is *what suppresses and for how long*: a
 * permanent bounce and a complaint block forever, a transient bounce blocks for
 * a day and then lifts by itself, because permanently blacklisting a real user
 * over a full mailbox would lock them out of their own account for good.
 */

const tempRoot = join(tmpdir(), `trippy-suppressions-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'suppressions.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let suppressions: typeof import('../src/persistence/suppressions.ts');
let mail: typeof import('../src/providers/mail.ts');

beforeAll(async () => {
	[{ db }, suppressions, mail] = await Promise.all([
		import('../src/db.ts'),
		import('../src/persistence/suppressions.ts'),
		import('../src/providers/mail.ts')
	]);
});

beforeEach(() => {
	db.prepare(`DELETE FROM mail_suppressions`).run();
});

afterAll(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** A minimal SES event as it arrives inside an SNS notification's Message. */
function bounce(type: string, ...addresses: string[]) {
	return {
		notificationType: 'Bounce',
		bounce: {
			bounceType: type,
			bounceSubType: 'General',
			bouncedRecipients: addresses.map((emailAddress) => ({ emailAddress }))
		}
	};
}

function complaint(...addresses: string[]) {
	return {
		notificationType: 'Complaint',
		complaint: {
			complaintFeedbackType: 'abuse',
			complainedRecipients: addresses.map((emailAddress) => ({ emailAddress }))
		}
	};
}

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe('applying an SES notification', () => {
	it('suppresses a permanent bounce, forever', () => {
		const hit = suppressions.applySesNotification(bounce('Permanent', 'gone@example.test'), NOW);
		expect(hit).toEqual([{ email: 'gone@example.test', reason: 'bounce', expires_at: null }]);
		expect(suppressions.isSuppressed('gone@example.test', NOW)).toBe(true);
		// Still blocked a decade later: a dead address does not come back.
		expect(suppressions.isSuppressed('gone@example.test', NOW + 3650 * DAY)).toBe(true);
	});

	it('suppresses a complaint, forever', () => {
		const hit = suppressions.applySesNotification(complaint('angry@example.test'), NOW);
		expect(hit).toEqual([{ email: 'angry@example.test', reason: 'complaint', expires_at: null }]);
		expect(suppressions.isSuppressed('angry@example.test', NOW)).toBe(true);
		expect(suppressions.isSuppressed('angry@example.test', NOW + 3650 * DAY)).toBe(true);
	});

	it('holds a transient bounce for a day and then lets it go', () => {
		// A full mailbox or a momentary server failure. Blocking forever here would
		// lock a real user out of their own account, because the password reset
		// they need is the very mail we would be refusing to send.
		const hit = suppressions.applySesNotification(bounce('Transient', 'busy@example.test'), NOW);
		expect(hit).toEqual([
			{ email: 'busy@example.test', reason: 'soft_bounce', expires_at: NOW + DAY }
		]);
		expect(suppressions.isSuppressed('busy@example.test', NOW)).toBe(true);
		expect(suppressions.isSuppressed('busy@example.test', NOW + DAY - 1)).toBe(true);
		expect(suppressions.isSuppressed('busy@example.test', NOW + DAY + 1)).toBe(false);
	});

	it('treats an undetermined bounce as transient, not permanent', () => {
		suppressions.applySesNotification(bounce('Undetermined', 'maybe@example.test'), NOW);
		expect(suppressions.isSuppressed('maybe@example.test', NOW + DAY + 1)).toBe(false);
	});

	it('keeps an expired soft hold visible to an operator', () => {
		// The block lapses; the evidence does not. An operator has to be able to
		// see why an address was ever held.
		suppressions.applySesNotification(bounce('Transient', 'busy@example.test'), NOW);
		const rows = suppressions.list(NOW + DAY + 1);
		expect(rows).toHaveLength(1);
		expect(rows[0].reason).toBe('soft_bounce');
		expect(rows[0].subtype).toBe('Transient');
		expect(rows[0].soft_count).toBe(1);
		expect(rows[0].active).toBe(false);
	});

	it('escalates to a permanent bounce after five transient failures', () => {
		// Five "temporary" failures is a dead mailbox wearing a polite face, and
		// every retry is still a bounce charged against the sending identity.
		let last;
		for (let i = 0; i < suppressions.SOFT_ESCALATION; i++) {
			last = suppressions.applySesNotification(bounce('Transient', 'gone@example.test'), NOW + i);
		}
		expect(last).toEqual([{ email: 'gone@example.test', reason: 'bounce', expires_at: null }]);
		expect(suppressions.isSuppressed('gone@example.test', NOW + 3650 * DAY)).toBe(true);
	});

	it('does not escalate before the fifth', () => {
		for (let i = 0; i < suppressions.SOFT_ESCALATION - 1; i++) {
			suppressions.applySesNotification(bounce('Transient', 'busy@example.test'), NOW + i);
		}
		expect(suppressions.isSuppressed('busy@example.test', NOW + 2 * DAY)).toBe(false);
	});

	it('never downgrades a permanent suppression to a temporary one', () => {
		// A complaint followed by a transient bounce must not hand the address a
		// delivery window it had already lost.
		suppressions.applySesNotification(complaint('angry@example.test'), NOW);
		suppressions.applySesNotification(bounce('Transient', 'angry@example.test'), NOW + 1);
		expect(suppressions.isSuppressed('angry@example.test', NOW + 10 * DAY)).toBe(true);
		expect(suppressions.list(NOW)[0].reason).toBe('complaint');
	});

	it('records the reason and the distinguishing subtype', () => {
		suppressions.applySesNotification(bounce('Permanent', 'gone@example.test'), NOW);
		suppressions.applySesNotification(complaint('angry@example.test'), NOW);
		const rows = suppressions.list(NOW);
		const gone = rows.find((r) => r.email === 'gone@example.test')!;
		const angry = rows.find((r) => r.email === 'angry@example.test')!;
		expect(gone.reason).toBe('bounce');
		expect(gone.subtype).toBe('Permanent');
		expect(angry.reason).toBe('complaint');
		expect(angry.subtype).toBe('abuse');
	});

	it('lowercases the address so a mixed-case send still matches', () => {
		suppressions.applySesNotification(bounce('Permanent', 'Gone@Example.Test'), NOW);
		expect(suppressions.isSuppressed('gone@example.test')).toBe(true);
		expect(suppressions.isSuppressed('GONE@EXAMPLE.TEST')).toBe(true);
	});

	it('suppresses every bounced recipient at once', () => {
		suppressions.applySesNotification(bounce('Permanent', 'a@example.test', 'b@example.test'), NOW);
		expect(suppressions.isSuppressed('a@example.test')).toBe(true);
		expect(suppressions.isSuppressed('b@example.test')).toBe(true);
	});

	it('ignores a delivery notification', () => {
		suppressions.applySesNotification({ notificationType: 'Delivery' } as never);
		expect(suppressions.list()).toHaveLength(0);
	});

	it('reads the newer eventType field as well as notificationType', () => {
		suppressions.applySesNotification({
			eventType: 'Bounce',
			bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'e@example.test' }] }
		});
		expect(suppressions.isSuppressed('e@example.test')).toBe(true);
	});
});

describe('an operator can undo a suppression', () => {
	it('lets a wrongly suppressed user back in', () => {
		// The recovery path that keeps a permanent suppression from being a life
		// sentence: the list says why, and unsuppress lifts it.
		suppressions.applySesNotification(bounce('Permanent', 'wrong@example.test'), NOW);
		expect(suppressions.list(NOW)[0].reason).toBe('bounce');
		suppressions.unsuppress('WRONG@example.test');
		expect(suppressions.isSuppressed('wrong@example.test')).toBe(false);
		expect(suppressions.list()).toHaveLength(0);
	});
});

describe('sendMail honours the suppression list', () => {
	it('does not mail a suppressed address, and says so', async () => {
		suppressions.suppress('blocked@example.test', 'complaint', 'abuse');
		// No mail provider is configured in this test process, so a normal address
		// returns 'skipped'. A suppressed one must return the distinct 'suppressed'
		// and, more importantly, never reach the provider path at all.
		const result = await mail.sendMail({
			to: 'blocked@example.test',
			subject: 'x',
			text: 'x',
			html: 'x'
		});
		expect(result).toBe('suppressed');
	});

	it('mails an address whose soft hold has expired', async () => {
		// The hold lapses on its own, so yesterday's full mailbox does not stop
		// today's password reset.
		suppressions.suppress('busy@example.test', 'soft_bounce', 'Transient', Date.now() - 1);
		const result = await mail.sendMail({
			to: 'busy@example.test',
			subject: 'x',
			text: 'x',
			html: 'x'
		});
		expect(result).toBe('skipped');
	});

	it('leaves an ordinary address to the normal path', async () => {
		const result = await mail.sendMail({
			to: 'fine@example.test',
			subject: 'x',
			text: 'x',
			html: 'x'
		});
		expect(result).toBe('skipped');
	});
});
