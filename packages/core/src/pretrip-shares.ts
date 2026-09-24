export type ShareCostItem = {
	homeCents: number;
	people: { id: string }[];
};

export function isFor(item: ShareCostItem, userId: string): boolean {
	return item.people.length === 0 || item.people.some((p) => p.id === userId);
}

export function shareOf(item: ShareCostItem, userId: string, memberCount: number): number {
	if (!isFor(item, userId)) return 0;
	const heads = item.people.length || memberCount;
	return heads > 0 ? Math.round(item.homeCents / heads) : 0;
}

export function amountFor(item: ShareCostItem, viewAs: string, memberCount: number): number {
	return viewAs ? shareOf(item, viewAs, memberCount) : item.homeCents;
}

export function totalFor(
	items: readonly ShareCostItem[],
	viewAs: string,
	memberCount: number
): number {
	return items.reduce((sum, item) => sum + amountFor(item, viewAs, memberCount), 0);
}
