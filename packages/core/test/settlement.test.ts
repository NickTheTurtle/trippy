import { describe, expect, it } from 'vitest';
import { settle, type Balance, type Transaction } from '@trippy/core/settlement';

function sumBalances(balances: Balance[]) {
	return balances.reduce((sum, balance) => sum + balance.netCents, 0);
}

function applyTransactions(balances: Balance[], transactions: Transaction[]) {
	const remaining = new Map(balances.map((balance) => [balance.userId, balance.netCents]));
	for (const transaction of transactions) {
		remaining.set(transaction.from, (remaining.get(transaction.from) ?? 0) + transaction.amountCents);
		remaining.set(transaction.to, (remaining.get(transaction.to) ?? 0) - transaction.amountCents);
	}
	return remaining;
}

function expectSettlesExactly(balances: Balance[]) {
	expect(sumBalances(balances)).toBe(0);
	const transactions = settle(balances);
	expect([...applyTransactions(balances, transactions).values()]).toEqual(balances.map(() => 0));
	expect(transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0)).toBe(
		balances.filter((balance) => balance.netCents > 0).reduce((sum, balance) => sum + balance.netCents, 0)
	);
	return transactions;
}

function balancesFromDebts(debts: { from: string; to: string; amountCents: number }[]): Balance[] {
	const net = new Map<string, number>();
	for (const debt of debts) {
		net.set(debt.from, (net.get(debt.from) ?? 0) - debt.amountCents);
		net.set(debt.to, (net.get(debt.to) ?? 0) + debt.amountCents);
	}
	return [...net.entries()].map(([userId, netCents]) => ({ userId, netCents }));
}

describe('settle', () => {
	it('settles balances that sum to exactly zero', () => {
		const transactions = expectSettlesExactly([
			{ userId: 'alice', netCents: 1200 },
			{ userId: 'bob', netCents: -700 },
			{ userId: 'carol', netCents: -500 }
		]);

		expect(transactions).toEqual([
			{ from: 'bob', to: 'alice', amountCents: 700 },
			{ from: 'carol', to: 'alice', amountCents: 500 }
		]);
	});

	it('keeps a one cent debt as a real transfer', () => {
		expect(settle([{ userId: 'debtor', netCents: -1 }, { userId: 'creditor', netCents: 1 }])).toEqual([
			{ from: 'debtor', to: 'creditor', amountCents: 1 }
		]);
	});

	it('uses the minimum number of transfers for a mixed group', () => {
		const balances = [
			{ userId: 'debtor-1', netCents: -500 },
			{ userId: 'debtor-2', netCents: -300 },
			{ userId: 'creditor-1', netCents: 200 },
			{ userId: 'creditor-2', netCents: 600 }
		];

		const transactions = expectSettlesExactly(balances);

		expect(transactions).toHaveLength(3);
		expect(transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0)).toBe(800);
	});

	it('leaves a zero balance member out of transfers', () => {
		const transactions = settle([
			{ userId: 'alice', netCents: 500 },
			{ userId: 'bob', netCents: -500 },
			{ userId: 'carol', netCents: 0 }
		]);

		expect(transactions).toEqual([{ from: 'bob', to: 'alice', amountCents: 500 }]);
		expect(transactions.some((transaction) => transaction.from === 'carol' || transaction.to === 'carol')).toBe(false);
	});

	it('settles one debtor against multiple creditors', () => {
		expect(settle([
			{ userId: 'debtor', netCents: -300 },
			{ userId: 'creditor-a', netCents: 100 },
			{ userId: 'creditor-b', netCents: 200 }
		])).toEqual([
			{ from: 'debtor', to: 'creditor-b', amountCents: 200 },
			{ from: 'debtor', to: 'creditor-a', amountCents: 100 }
		]);
	});

	it('settles multiple debtors against one creditor', () => {
		expect(settle([
			{ userId: 'debtor-a', netCents: -100 },
			{ userId: 'debtor-b', netCents: -200 },
			{ userId: 'creditor', netCents: 300 }
		])).toEqual([
			{ from: 'debtor-b', to: 'creditor', amountCents: 200 },
			{ from: 'debtor-a', to: 'creditor', amountCents: 100 }
		]);
	});

	it('uses user id as a stable tie break for equal balances', () => {
		expect(settle([
			{ userId: 'debtor-b', netCents: -100 },
			{ userId: 'creditor-b', netCents: 100 },
			{ userId: 'debtor-a', netCents: -100 },
			{ userId: 'creditor-a', netCents: 100 }
		])).toEqual([
			{ from: 'debtor-a', to: 'creditor-a', amountCents: 100 },
			{ from: 'debtor-b', to: 'creditor-b', amountCents: 100 }
		]);
	});

	it('keeps amount derivation aligned with amount cents', () => {
		const [transaction] = settle([{ userId: 'debtor', netCents: -1234 }, { userId: 'creditor', netCents: 1234 }]);

		expect(transaction.amountCents / 100).toBe(12.34);
	});

	it('nets a three-way debt cycle down to fewer transfers than participants', () => {
		const balances = balancesFromDebts([
			{ from: 'alice', to: 'bob', amountCents: 1000 },
			{ from: 'bob', to: 'carol', amountCents: 1000 },
			{ from: 'carol', to: 'alice', amountCents: 750 }
		]);

		const transactions = expectSettlesExactly(balances);

		expect(transactions).toEqual([{ from: 'alice', to: 'carol', amountCents: 250 }]);
		expect(transactions.length).toBeLessThan(3);
	});

	it('settles when one person paid for everything', () => {
		const balances = [
			{ userId: 'alice', netCents: 3000 },
			{ userId: 'bob', netCents: -1000 },
			{ userId: 'carol', netCents: -1000 },
			{ userId: 'dinesh', netCents: -1000 }
		];

		expect(expectSettlesExactly(balances)).toEqual([
			{ from: 'bob', to: 'alice', amountCents: 1000 },
			{ from: 'carol', to: 'alice', amountCents: 1000 },
			{ from: 'dinesh', to: 'alice', amountCents: 1000 }
		]);
	});

	it('preserves every cent from an odd total that cannot divide evenly', () => {
		const balances = [
			{ userId: 'payer', netCents: 66 },
			{ userId: 'guest-a', netCents: -33 },
			{ userId: 'guest-b', netCents: -33 }
		];

		const transactions = expectSettlesExactly(balances);

		expect(transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0)).toBe(66);
	});

	it('settles a large realistic group exactly', () => {
		const balances: Balance[] = [
			{ userId: 'member-01', netCents: 12450 },
			{ userId: 'member-02', netCents: 9800 },
			{ userId: 'member-03', netCents: 7350 },
			{ userId: 'member-04', netCents: 6150 },
			{ userId: 'member-05', netCents: 4200 },
			{ userId: 'member-06', netCents: 3100 },
			{ userId: 'member-07', netCents: 1900 },
			{ userId: 'member-08', netCents: 850 },
			{ userId: 'member-09', netCents: -400 },
			{ userId: 'member-10', netCents: -950 },
			{ userId: 'member-11', netCents: -1350 },
			{ userId: 'member-12', netCents: -2200 },
			{ userId: 'member-13', netCents: -3600 },
			{ userId: 'member-14', netCents: -4750 },
			{ userId: 'member-15', netCents: -6100 },
			{ userId: 'member-16', netCents: -7850 },
			{ userId: 'member-17', netCents: -9200 },
			{ userId: 'member-18', netCents: -9450 },
			{ userId: 'member-19', netCents: 1050 },
			{ userId: 'member-20', netCents: -1000 }
		];

		const transactions = expectSettlesExactly(balances);

		expect(transactions.every((transaction) => transaction.amountCents > 0)).toBe(true);
		expect(transactions.length).toBeLessThan(balances.filter((balance) => balance.netCents !== 0).length);
	});
});
