/**
 * Minimal-transaction settlement (Splitwise-style).
 *
 * Input: net balance per user in the trip's home currency, in whole minor units
 *        (cents; positive = is owed money, negative = owes money).
 * Output: a minimal set of transfers, also in whole cents, that brings everyone
 *        to zero.
 *
 * All arithmetic here is integer. Money is carried as minor units everywhere
 * and only formatted into a major-unit string at the edge, so nothing can drift
 * and there is no epsilon: a one-cent imbalance is a real debt and gets a real
 * transfer instead of being rounded out of existence. Given balances that sum
 * to zero, the transfers reconcile them to zero exactly.
 */

export interface Balance {
	userId: string;
	netCents: number; // home currency minor units, paid - owed
}

export interface Transaction {
	from: string; // debtor
	to: string; // creditor
	amountCents: number; // always positive
}

export function settle(balances: Balance[]): Transaction[] {
	const whole = balances.map((b) => ({ userId: b.userId, netCents: Math.round(b.netCents) }));
	// Ties broken by user id so the suggested transfers are stable between
	// requests rather than following whatever order the rows arrived in.
	const creditors = whole
		.filter((b) => b.netCents > 0)
		.sort((a, b) => b.netCents - a.netCents || (a.userId < b.userId ? -1 : 1));
	const debtors = whole
		.filter((b) => b.netCents < 0)
		.sort((a, b) => a.netCents - b.netCents || (a.userId < b.userId ? -1 : 1));

	const txns: Transaction[] = [];
	let i = 0;
	let j = 0;
	while (i < debtors.length && j < creditors.length) {
		const debtor = debtors[i];
		const creditor = creditors[j];
		const amountCents = Math.min(-debtor.netCents, creditor.netCents);
		if (amountCents > 0) {
			txns.push({ from: debtor.userId, to: creditor.userId, amountCents });
			debtor.netCents += amountCents;
			creditor.netCents -= amountCents;
		}
		if (debtor.netCents === 0) i++;
		if (creditor.netCents === 0) j++;
	}
	return txns;
}
