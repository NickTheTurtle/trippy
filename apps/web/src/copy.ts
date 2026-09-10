/**
 * Every user-facing string the client authors, in one place, so the wording can
 * be read and edited without going through the components that render it.
 *
 * Nesting follows the app's surfaces, in the order a user meets them. Strings
 * that interpolate a value are functions taking that value, so the sentence
 * stays whole here rather than being assembled at the call site.
 *
 * Not here: text the server sends at runtime, and the schedule page, which is
 * frozen pending its redesign.
 */
export const copy = {
	// Auth > login and register pages
	auth: {
		login: {
			title: 'Welcome back',
			blurb: 'Log in to keep planning.',
			submitLabel: 'Log in',
			fallback: 'Could not log in.',
			footerPrompt: 'New here?',
			footerLink: 'Create an account',
			emailLabel: 'Email',
			passwordLabel: 'Password'
		},
		register: {
			title: 'Create your account',
			blurb: 'Start planning your first trip.',
			submitLabel: 'Create account',
			fallback: 'Could not create the account.',
			footerPrompt: 'Already have an account?',
			footerLink: 'Log in',
			nameLabel: 'Name',
			emailLabel: 'Email',
			passwordLabel: 'Password',
			passwordHint: 'At least 8 characters'
		}
	},

	// App shell > sticky top bar and its account menu
	shell: {
		brand: 'Trippy',
		accountSettings: 'Account settings',
		logOut: 'Log out',
		logIn: 'Log in',
		register: 'Start planning'
	},

	// Trip tab bar (nav.ts)
	nav: {
		discover: 'Discover',
		pretrip: 'Preparation',
		calendar: 'Schedule',
		expenses: 'Expenses',
		people: 'People'
	},

	// Landing page, seen only when signed out
	landing: {
		heading: 'Plan the trip together, not in twelve group chats.',
		blurb:
			"Trippy keeps a group's places, days, beds and money in one place, in every time zone the trip passes through.",
		primaryCta: 'Start planning',
		secondaryCta: 'Log in',
		features: [
			{
				title: 'Collect the places',
				body: 'Search a city and everyone adds what they want to see. Vote, so the shortlist picks itself.'
			},
			{
				title: 'Build the days',
				body: 'Put places on a calendar with the travel time between them already worked out.'
			},
			{
				title: 'Split the group',
				body: 'Run parallel tracks when half the group wants the museum and half wants the beach.'
			},
			{
				title: 'Pick where to sleep',
				body: 'Put the options up with prices and nights, let the group vote, then lock the choice.'
			},
			{
				title: 'Know what it costs',
				body: 'Estimate before you go, log what was actually spent, in whichever currency it was spent in.'
			},
			{
				title: 'Settle up at the end',
				body: 'The fewest transfers that clear everyone, and a button to record each one as paid.'
			}
		]
	},

	// Catch-all route for an unknown URL
	notFound: {
		heading: 'Page not found',
		body: 'That link does not point at anything in this app.',
		backAuthenticated: 'Back to my trips',
		backAnonymous: 'Back to the start'
	},

	// Trips list, the signed-in home page
	trips: {
		heading: 'My trips',
		newTrip: 'New trip',
		emptyMessage: 'No trips yet.',
		emptyAction: 'New trip',
		cityCount: (cities: number) => `${cities} ${cities === 1 ? 'city' : 'cities'}`,
		memberCount: (members: number) => `${members} ${members === 1 ? 'person' : 'people'}`,
		newDialog: {
			title: 'New trip',
			submitLabel: 'Create trip',
			busyLabel: 'Creating...',
			fallback: 'Could not create the trip.'
		}
	},

	// Trip form, shared by the New trip and Edit trip dialogs
	tripForm: {
		nameLabel: 'Name',
		startLabel: 'Start',
		endLabel: 'End',
		currencyLabel: 'Currency',
		currencyAriaLabel: 'Home currency'
	},

	// Trip shell > header, edit dialog, live-updates notice
	tripShell: {
		notFound: 'Trip not found.',
		notFoundLink: 'Back to trips',
		backToTrips: '← All trips',
		editTrip: 'Edit trip',
		editDialog: {
			title: 'Edit trip',
			submitLabel: 'Save changes',
			fallback: 'Could not save.'
		},
		liveOff: "Live updates are off, so you will not see other people's changes.",
		reconnect: 'Reconnect'
	},

	// Add city dialog, reached from Discover
	addCity: {
		title: 'Add city',
		done: 'Done',
		saveFallback: 'Could not save that.',
		addFallback: 'Could not add that city.',
		searchLabel: 'City',
		searchPlaceholder: 'Kyoto, Lisbon, Cusco...',
		addPicked: (city: string) => `Add ${city}`,
		searching: 'Searching...',
		noMatches: 'No cities matched that.'
	},

	// Discover > city sidebar, place and stay cards, add and edit dialogs
	discover: {
		types: {
			attraction: 'Attractions',
			food: 'Food & Drink',
			stay: 'Stays'
		},
		noCities: {
			heading: 'Getting Started',
			body: 'Every great trip requires a destination. Add a city to start planning for your trip.',
			cta: 'Add a city',
			memberNote: 'Waiting for an organizer to add the first stop...'
		},
		cityList: {
			navLabel: 'Cities',
			addCity: 'Add city',
			removeLabel: (city: string) => `Delete ${city}`,
			lastCityTitle: 'A trip needs at least one city',
			deleteTitle: (city: string) => `Delete ${city}?`,
			deleteConfirm: 'Delete city',
			deleteBody: (places: number, stays: number, city: string) => {
				const bits = [
					places > 0 ? `${places} ${places === 1 ? 'place' : 'places'}` : '',
					stays > 0 ? `${stays} ${stays === 1 ? 'stay' : 'stays'}` : ''
				].filter(Boolean);
				return bits.length > 0
					? `Deletes ${bits.join(' and ')} in ${city}.`
					: `Nothing has been added to ${city} yet.`;
			},
			deleteLinked: (linked: number) =>
				`${linked} scheduled ${linked === 1 ? 'event stays' : 'events stay'} on the calendar, but ${linked === 1 ? 'loses' : 'lose'} the link back to the place.`
		},
		header: {
			typeAriaLabel: 'Type',
			voted: (voted: number, members: number) => `${voted} of ${members} voted`,
			addStay: 'Add a stay',
			addPlace: 'Add a place'
		},
		deletePlace: {
			title: 'Delete this place?',
			confirmLabel: (linked: number) => `Delete and ${linked} event${linked === 1 ? '' : 's'}`,
			linkedBody: (linked: number) =>
				`${linked} scheduled ${linked === 1 ? 'event' : 'events'} linked to this place ${
					linked === 1 ? 'is' : 'are'
				} deleted too.`,
			unlinkedBody: 'Nothing on the calendar is linked to it.'
		},
		errors: {
			votePlace: 'Could not vote on that place.',
			voteStay: 'Could not vote on that stay.',
			lockStay: 'Could not lock that stay.',
			removeStay: 'Could not remove that stay.',
			saveDates: 'Could not save those dates.'
		},
		card: {
			voteLabel: (youVoted: boolean, subject: string) =>
				`${youVoted ? 'Remove your vote from' : 'Vote for'} ${subject}`,
			openLabel: (name: string) => `Open ${name} (opens in a new tab)`
		},
		placeCard: {
			onCalendar: (linked: number) => `🗓 On the calendar ×${linked}`,
			removeLabel: (name: string) => `Remove ${name}`
		},
		stayCard: {
			locked: 'Locked',
			priceTbd: 'Price TBD',
			removeLabel: (name: string) => `Remove ${name}`,
			editDates: 'Edit dates',
			setDates: 'Set dates',
			lockLabel: (locked: boolean) => (locked ? 'Unlock' : 'Lock as choice'),
			lockAriaLabel: (locked: boolean, name: string) =>
				`${locked ? 'Unlock' : 'Lock as choice'}: ${name}`,
			checkInLabel: 'In',
			checkOutLabel: 'Out',
			saveDates: 'Save'
		},
		placeFields: {
			typeLabel: 'Type',
			typeAriaLabel: 'Type',
			notesLabel: 'Notes',
			linkLabel: 'Link',
			linkPlaceholder: 'https://'
		},
		addDialog: {
			title: (city: string) => `Add to ${city}`,
			nameLabel: 'Name',
			keepTyping: 'Keep typing to search.',
			searching: 'Searching...',
			noMatches: (query: string) => `No matches for "${query}". Add it by hand instead.`,
			attribution: (provider: string) => `Powered by ${provider}`,
			providerGoogle: 'Google Maps',
			providerOsm: 'OpenStreetMap',
			notThisOne: 'Not this one',
			priceLabel: 'Price / night',
			activityLabel: 'Activity',
			badPrice: 'Enter the nightly price as a number, or leave it blank.',
			added: (count: number) =>
				`Added${count > 1 ? ` \u00d7${count}` : ''}. Add another activity for the same place, or close.`,
			close: 'Close',
			busyLabel: 'Loading...',
			submitStay: 'Add stay',
			submitPlace: 'Add place',
			fallback: 'Could not add that.'
		},
		editPlace: {
			title: 'Edit place',
			nameLabel: 'Name',
			votes: (votes: number) => (votes === 1 ? '1 vote' : `${votes} votes`),
			voters: (voters: readonly string[]) =>
				voters.length ? `: ${voters.join(', ')}` : ', nobody yet',
			submitLabel: 'Save',
			fallback: 'Could not save that place.'
		}
	},

	// Preparation > tasks, packing list, cost estimates
	preparation: {
		navAriaLabel: 'Preparation sections',
		sections: { tasks: 'Tasks', packing: 'Packing', costs: 'Estimated costs' },
		addTask: '+ Add task',
		addPackingItem: '+ Add item',
		addCost: '+ Add cost',
		emptyTasks: 'No tasks yet.',
		emptyPacking: 'No packing items yet.',
		tripTotal: 'Trip total',
		perPerson: 'Per person',
		youSuffix: ' (you)',
		saveFallback: 'Could not save that.',
		deleteTask: {
			taskTitle: 'Delete this task?',
			packingTitle: 'Delete this packing item?',
			assignedBody: (people: number, done: number) =>
				`Assigned to ${people} ${
					people === 1 ? 'person' : 'people'
				}, ${done} of whom have ticked it off. The row and everyone's ticks go.`,
			unassignedBody: 'The row goes, along with whether it was ticked off.'
		},
		deleteCost: {
			title: 'Delete this estimate?',
			body: (amount: string, category: string, city: string | null) =>
				`${amount} under ${category}${
					city ? ` in ${city}` : ''
				}. The trip total and the per-person figure drop by it. Logged expenses are not affected.`
		},
		taskList: {
			taskAction: 'Add task',
			packingAction: 'Add item',
			sharedBoxLabel: (done: boolean, label: string) =>
				`${done ? 'Mark not done' : 'Mark done'}: ${label}`,
			yourBoxLabel: (done: boolean, label: string) =>
				`${done ? 'Mark not done for you' : 'Mark done for you'}: ${label}`,
			othersTitle: (done: boolean) =>
				done ? 'Done by the people it is assigned to' : 'Assigned to other people',
			othersLabel: (label: string, done: boolean) =>
				`${label} is assigned to other people and is ${done ? 'done' : 'not done yet'}`,
			rosterTitle: 'Who still has to do this',
			youDone: 'You: done',
			youToDo: 'You: to do',
			removeLabel: (kind: string, label: string) => `Remove ${kind}: ${label}`,
			rosterToggleLabel: (done: boolean, label: string) =>
				`${done ? 'Mark not done' : 'Mark done'} for you: ${label}`
		},
		addTaskDialog: {
			taskTitle: 'Add a task',
			packingTitle: 'Add a packing item',
			labelField: 'What needs doing?',
			assigneesLegend: 'Who has to do it?',
			noMembers: 'No members yet.',
			selectEveryone: 'Select everyone',
			clear: 'Clear',
			submitLabel: 'Add',
			fallback: 'Could not add that.'
		},
		costTable: {
			item: 'Item',
			category: 'Category',
			city: 'City',
			amount: 'Amount',
			noCity: 'General',
			editLabel: (label: string) => `Edit ${label}`,
			removeLabel: (label: string) => `Remove ${label}`,
			empty: 'No estimates yet.',
			total: 'Total'
		},
		costDialog: {
			editTitle: 'Edit cost',
			addTitle: 'Add cost',
			labelField: 'What is it?',
			amountLabel: (currency: string) => `Amount (${currency})`,
			categoryLabel: 'Category',
			categoryAriaLabel: 'Category',
			cityLabel: 'City',
			cityAriaLabel: 'City',
			anyCity: 'All / general',
			saveLabel: 'Save changes',
			addLabel: 'Add cost',
			fallback: 'Could not save that item.'
		}
	},

	// Expenses > ledger, balances, settle up
	expenses: {
		navAriaLabel: 'Expense sections',
		sections: { expenses: 'Expenses', balances: 'Balances', settle: 'Settle up' },
		ledgerHead: 'Use a negative amount for a refund or payout.',
		addExpense: '+ Add expense',
		emptyMessage: 'No expenses yet.',
		emptyAction: 'Add expense',
		balancesHead: (currency: string) => `Net position per person, in ${currency}.`,
		allEven: 'Everyone is even.',
		youTag: 'you',
		settleHead: 'Minimum transfers to clear all balances.',
		nothingToSettle: 'Nothing to settle.',
		deletePaymentTitle: 'Delete this payment?',
		deleteExpenseTitle: 'Delete this expense?',
		deleteBody: (
			amount: string,
			homeAmount: string | null,
			payer: string,
			received: boolean,
			when: string,
			settlement: boolean
		) =>
			`${amount}${homeAmount ? ` (≈ ${homeAmount})` : ''}, ${payer}${
				received ? ' received' : ' paid'
			}, ${when}. ${
				settlement
					? 'The balance it cleared comes back.'
					: 'Everyone on it has their balance recalculated.'
			}`,
		row: {
			paymentTag: 'payment',
			incomeTag: 'income',
			received: 'received',
			paid: 'paid',
			splitLabel: (mode: string, participants: number) => {
				const people = `${participants} ${participants === 1 ? 'way' : 'ways'}`;
				if (mode === 'shares') return `split by shares, ${people}`;
				if (mode === 'exact') return `split by amount, ${people}`;
				return `split ${people}`;
			},
			deleteLabel: (description: string) => `Delete ${description}`
		},
		settleRow: {
			pays: 'pays',
			busyLabel: 'Saving',
			markPaid: 'Mark paid',
			markPaidLabel: (from: string, to: string, amount: string) =>
				`Record that ${from} paid ${to} ${amount}`,
			fallback: 'Could not record that payment.'
		},
		addDialog: {
			modes: {
				even: { label: 'Evenly', hint: 'Everyone selected pays the same.' },
				shares: { label: 'By shares', hint: 'Weight each person: 2 shares pays double.' },
				exact: { label: 'By amount', hint: 'Type what each person owes.' }
			},
			incomeTitle: 'Add income',
			expenseTitle: 'Add expense',
			descriptionLabel: 'Description',
			amountLabel: 'Amount',
			currencyLabel: 'Currency',
			currencyAriaLabel: 'Currency',
			receivedByLabel: 'Received by',
			paidByLabel: 'Paid by',
			payerAriaLabel: 'Paid by',
			incomeNote: 'Saved as income: everyone selected is credited instead of charged.',
			expenseNote: 'Use a negative amount for a refund or payout.',
			splitLabel: 'Split',
			splitAriaLabel: 'Split method',
			selectedCount: (chosen: number, members: number) => `${chosen} of ${members} selected`,
			fullyAllocated: ' · fully allocated',
			remainder: (amount: string, left: boolean) => ` · ${amount} ${left ? 'left' : 'over'}`,
			splitTheRest: 'Split the rest',
			all: 'All',
			none: 'None',
			weightLabel: (exact: boolean, name: string) => `${exact ? 'Amount' : 'Shares'} for ${name}`,
			saveIncome: 'Save income',
			saveExpense: 'Save expense',
			fallback: 'Could not save that expense.'
		}
	},

	// People > roster, invite panel, removal confirmation
	people: {
		membersHeading: 'Members',
		removeTitle: (name: string) => `Remove ${name}?`,
		removeConfirm: 'Remove',
		removeBusy: 'Removing...',
		row: {
			notJoined: (email: string) => `${email} (not joined yet)`,
			sampleCompanion: 'Sample companion',
			youTag: 'you',
			organizerTag: 'organizer',
			invitedTag: 'invited',
			sampleTag: 'sample',
			remove: 'Remove',
			removeLabel: (name: string) => `Remove ${name}`
		},
		invite: {
			heading: 'Invite someone',
			emailLabel: 'Email address',
			busyLabel: 'Sending...',
			submitLabel: 'Send invite',
			fallback: 'Could not send that invite.'
		},
		removeBody: {
			placeholderBody: (email: string) =>
				`Invited at ${email}, never joined. The invite is withdrawn and their record is deleted. You can invite the address again.`,
			memberBody: 'They lose access to this trip. Their account and other trips are untouched.',
			settlementWarning:
				'Balances on this trip will change, so who owes whom will not be what it was.',
			destroyed: (list: string) => `Permanently deleted: ${list}.`,
			otherShares: (shares: string) =>
				`That also deletes ${shares} other people had on those expenses.`,
			retained: (list: string) => `Kept, with their name on it: ${list}.`,
			units: {
				expensesPaid: { one: 'expense they paid', many: 'expenses they paid' },
				expenseShares: { one: 'share they owe', many: 'shares they owe' },
				poiVotes: { one: 'place vote', many: 'place votes' },
				lodgingVotes: { one: 'stay vote', many: 'stay votes' },
				itemAssignments: { one: 'calendar assignment', many: 'calendar assignments' },
				taskAssignments: { one: 'task assignment', many: 'task assignments' },
				taskCompletions: { one: 'ticked-off task', many: 'ticked-off tasks' },
				partySegments: { one: 'crew membership', many: 'crew memberships' },
				shares: { one: 'share', many: 'shares' }
			}
		}
	},

	// Account settings > profile and password
	account: {
		heading: 'Account settings',
		loading: 'Loading...',
		profile: {
			heading: 'Profile',
			saved: 'Profile saved.',
			nameLabel: 'Name',
			emailLabel: 'Email',
			timeZoneLabel: 'Home time zone',
			timeZoneAriaLabel: 'Home time zone',
			submitLabel: 'Save profile',
			fallback: 'Could not save your profile.'
		},
		password: {
			heading: 'Password',
			updated: 'Password updated.',
			currentLabel: 'Current password',
			newLabel: 'New password',
			newHint: 'At least 8 characters',
			confirmLabel: 'Confirm new password',
			submitLabel: 'Change password',
			fallback: 'Could not change your password.'
		}
	},

	// Shared UI components > defaults and accessible names
	ui: {
		modal: { closeLabel: 'Close' },
		confirmDialog: {
			undone: 'This cannot be undone.',
			fallback: 'Could not do that.'
		},
		searchDropdown: { busyLabel: 'Searching' },
		select: { placeholder: 'Select...', ariaLabel: 'Select' },
		multiSelect: {
			placeholder: 'Anyone',
			ariaLabel: 'Assign people',
			summaryLabel: (count: number) => `${count} people`,
			empty: 'No members yet'
		},
		sectionNav: { ariaLabel: 'Sections' },
		field: { optionalSuffix: ' (optional)' },
		tripMap: { noPoints: 'Schedule places with locations to see them on the map.' }
	},

	// Shared API client and hooks > fallbacks used when the server sends none
	api: {
		unreachable: 'Could not reach the server. Check your connection.',
		requestFailed: 'Could not complete that. Try again.',
		loadFailed: 'Could not load this page.',
		saveFallback: 'Could not save that.'
	},

	// Generic control labels reused across unrelated surfaces
	common: {
		cancel: 'Cancel',
		delete: 'Delete',
		saving: 'Saving...',
		deleting: 'Deleting...',
		adding: 'Adding...',
		working: 'Working...'
	}
} as const;
