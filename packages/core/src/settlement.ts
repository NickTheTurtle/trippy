/**
 * Minimal-transaction settlement (Splitwise-style).
 * Input: net balance per user in the trip's home currency
 *        (positive = is owed money, negative = owes money).
 * Output: a minimal set of transactions to bring everyone to zero.
 */

export interface Balance {
	userId: string;
	net: number; // home-currency, paid - owed
}

export interface Transaction {
	from: string; // debtor
	to: string; // creditor
	amount: number;
}

export function settle(balances: Balance[], epsilon = 0.01): Transaction[] {
	const creditors = balances
		.filter((b) => b.net > epsilon)
		.map((b) => ({ ...b }))
		.sort((a, b) => b.net - a.net);
	const debtors = balances
		.filter((b) => b.net < -epsilon)
		.map((b) => ({ ...b }))
		.sort((a, b) => a.net - b.net);

	const txns: Transaction[] = [];
	let i = 0;
	let j = 0;
	while (i < debtors.length && j < creditors.length) {
		const debtor = debtors[i];
		const creditor = creditors[j];
		const amount = Math.min(-debtor.net, creditor.net);
		if (amount > epsilon) {
			txns.push({
				from: debtor.userId,
				to: creditor.userId,
				amount: Math.round(amount * 100) / 100
			});
			debtor.net += amount;
			creditor.net -= amount;
		}
		if (Math.abs(debtor.net) <= epsilon) i++;
		if (Math.abs(creditor.net) <= epsilon) j++;
	}
	return txns;
}
