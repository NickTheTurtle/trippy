/**
 * The shape of `GET /trips/:id/pretrip`, which answers with the task list,
 * the packing list and the cost estimates in one payload.
 */
export type Person = { id: string; name: string; done: boolean };
export type Task = {
	id: string;
	label: string;
	flag: string | null;
	people: Person[];
	shared: boolean;
	done: boolean;
	doneCount: number;
};
export type CostItem = {
	id: string;
	label: string;
	category: string;
	cityId: string | null;
	cityName: string | null;
	amountCents: number;
};
export type PretripData = {
	me: string;
	members: { id: string; name: string }[];
	tasks: Task[];
	packing: Task[];
	currency: string;
	memberCount: number;
	categories: string[];
	cities: { id: string; name: string }[];
	budget: {
		items: CostItem[];
		categoryTotals: Record<string, number>;
		grandTotal: number;
	};
};

/** Add and edit of a cost estimate share one modal; `id` is null when adding. */
export type Draft = {
	id: string | null;
	label: string;
	amount: string;
	category: string;
	cityId: string;
};
