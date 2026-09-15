/**
 * The shape of `GET /trips/:id/pretrip`, which answers with the task list,
 * the packing list and the cost estimates in one payload.
 */
import type { Crew } from '../people/types';

export type Person = { id: string; name: string; done: boolean };
export type Task = {
	id: string;
	label: string;
	flag: string | null;
	people: Person[];
	shared: boolean;
	done: boolean;
	doneCount: number;
	/** Bumped on every save; sent back on edit so a stale write is refused. */
	version: number;
};
export type CostItem = {
	id: string;
	label: string;
	category: string;
	amountCents: number;
	/** The currency `amountCents` is in. Blank means the trip's home currency. */
	currency: string;
	/** `amountCents` in the trip's home currency. All the totals use this. */
	homeCents: number;
	/** Who the line is for. Empty means the whole trip. */
	people: { id: string; name: string }[];
};
export type PretripData = {
	me: string;
	members: { id: string; name: string }[];
	/** Saved groups of members, offered as shortcuts in the people pickers. */
	crews: Crew[];
	tasks: Task[];
	packing: Task[];
	currency: string;
	currencies: string[];
	memberCount: number;
	categories: string[];
	budget: {
		items: CostItem[];
		grandTotal: number;
	};
};

/** Add and edit of a cost estimate share one modal; `id` is null when adding. */
export type Draft = {
	id: string | null;
	label: string;
	amount: string;
	currency: string;
	category: string;
	assignees: string[];
};

/** The same for a task or a packing item: `id` is null when adding. */
export type TaskDraft = {
	id: string | null;
	kind: 'task' | 'packing';
	label: string;
	assignees: string[];
	/** The version the dialog opened on. Null when adding. */
	version: number | null;
};
