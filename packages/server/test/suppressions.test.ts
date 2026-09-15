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
 * The one thing these cases have to pin is *what suppresses*: a permanent bounce
 * and a complaint do, a transient bounce does not, because permanently
 * blacklisting a real user over a full mailbox would lock them out for good.
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

describe('applying an SES notification', () => {
	it('suppresses a permanent bounce', () => {
		const hit = suppressions.applySesNotification(bounce('Permanent', 'gone@example.test'));
		expect(hit).toEqual(['gone@example.test']);
		expect(suppressions.isSuppressed('gone@example.test')).toBe(true);
	});

	it('does NOT suppress a transient bounce', () => {
		// A full mailbox or a momentary server failure. Suppressing here would lock
		// a real user out of their own account forever, which is the whole point.
		const hit = suppressions.applySesNotification(bounce('Transient', 'busy@example.test'));
		expect(hit).toEqual([]);
		expect(suppressions.isSuppressed('busy@example.test')).toBe(false);
	});

	it('does not suppress an undetermined bounce either', () => {
		suppressions.applySesNotification(bounce('Undetermined', 'maybe@example.test'));
		expect(suppressions.isSuppressed('maybe@example.test')).toBe(false);
	});

	it('suppresses a complaint', () => {
		const hit = suppressions.applySesNotification(complaint('angry@example.test'));
		expect(hit).toEqual(['angry@example.test']);
		expect(suppressions.isSuppressed('angry@example.test')).toBe(true);
	});

	it('records the reason and the distinguishing subtype', () => {
		suppressions.applySesNotification(bounce('Permanent', 'gone@example.test'));
		suppressions.applySesNotification(complaint('angry@example.test'));
		const rows = suppressions.listSuppressions();
		const gone = rows.find((r) => r.email === 'gone@example.test')!;
		const angry = rows.find((r) => r.email === 'angry@example.test')!;
		expect(gone.reason).toBe('bounce');
		expect(gone.subtype).toBe('Permanent');
		expect(angry.reason).toBe('complaint');
		expect(angry.subtype).toBe('abuse');
	});

	it('lowercases the address so a mixed-case send still matches', () => {
		suppressions.applySesNotification(bounce('Permanent', 'Gone@Example.Test'));
		expect(suppressions.isSuppressed('gone@example.test')).toBe(true);
		expect(suppressions.isSuppressed('GONE@EXAMPLE.TEST')).toBe(true);
	});

	it('suppresses every bounced recipient at once', () => {
		suppressions.applySesNotification(bounce('Permanent', 'a@example.test', 'b@example.test'));
		expect(suppressions.isSuppressed('a@example.test')).toBe(true);
		expect(suppressions.isSuppressed('b@example.test')).toBe(true);
	});

	it('ignores a delivery notification', () => {
		suppressions.applySesNotification({ notificationType: 'Delivery' } as never);
		expect(suppressions.listSuppressions()).toHaveLength(0);
	});

	it('reads the newer eventType field as well as notificationType', () => {
		suppressions.applySesNotification({
			eventType: 'Bounce',
			bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'e@example.test' }] }
		});
		expect(suppressions.isSuppressed('e@example.test')).toBe(true);
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
