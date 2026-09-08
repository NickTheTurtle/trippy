/** The nine sections under /trips/:tripId, in the order the tab bar shows them. */
export const SECTIONS = [
	{ slug: 'calendar', label: 'Calendar' },
	{ slug: 'discover', label: 'Discover' },
	{ slug: 'pretrip', label: 'Preparation' },
	{ slug: 'costs', label: 'Costs' },
	{ slug: 'expenses', label: 'Expenses' },
	{ slug: 'people', label: 'People' },
	{ slug: 'settings', label: 'Settings' }
] as const;
