/**
 * Every user-facing string the client authors, in one place, so the wording can
 * be read and edited without going through the components that render it.
 *
 * Nesting follows the app's surfaces, in the order a user meets them. Strings
 * that interpolate a value are functions taking that value, so the sentence
 * stays whole here rather than being assembled at the call site.
 *
 * Not here: text the server sends at runtime.
 */

/** The whole group. Said on several surfaces, and must read the same on each. */
const EVERYONE = 'Everyone';

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
			passwordHint: 'At least 8 characters',
			sentTitle: 'Check your email',
			sentBlurb: 'Open the link we sent to finish setting up your account.'
		},
		forgot: {
			title: 'Forgot your password',
			blurb: 'We will email you a link to set a new one.',
			submitLabel: 'Email me a link',
			fallback: 'Could not send that link.',
			footerPrompt: 'Remembered it?',
			footerLink: 'Log in',
			emailLabel: 'Email',
			link: 'Forgot your password?',
			sentTitle: 'Check your email',
			sentBlurb: 'If that address has an account, a reset link is on its way.'
		},
		reset: {
			title: 'Set a new password',
			blurb: 'Choose a password you have not used here before.',
			submitLabel: 'Save password',
			fallback: 'Could not change that password.',
			footerPrompt: 'Changed your mind?',
			footerLink: 'Log in',
			passwordLabel: 'New password',
			passwordHint: 'At least 8 characters',
			doneTitle: 'Password changed',
			doneBlurb: 'Log in with your new password.'
		},
		verify: {
			title: 'Confirming your email',
			blurb: 'One moment.',
			failedTitle: 'That link did not work',
			retry: 'Create an account',
			/** Beside `retry`: the account may already exist, from an earlier link. */
			logIn: 'Log in'
		},
		/** The link sent to a new address when a signed-in member changes their email. */
		verifyEmail: {
			title: 'Confirming your new email',
			blurb: 'One moment.',
			doneTitle: 'Email changed',
			doneBlurb: 'Log in with the new address from now on.',
			failedTitle: 'That link did not work'
		}
	},

	// Native auth link notice
	mobileAuth: {
		openWebLink: 'Open the email link in the web app, then log in here.'
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
		preparation: 'Preparation',
		schedule: 'Schedule',
		expenses: 'Expenses',
		people: 'People'
	},

	// Landing page, seen only when signed out
	landing: {
		heading: 'Plan the trip together, not in twelve group chats.',
		blurb:
			"Trippy keeps a group's locations, days, beds and money in one place, in every time zone the trip passes through.",
		primaryCta: 'Start planning',
		secondaryCta: 'Log in',
		features: [
			{
				title: 'Collect the locations',
				body: 'Search a city and everyone adds what they want to see. Vote, so the shortlist picks itself.'
			},
			{
				title: 'Build the days',
				body: 'Put locations on a calendar with the travel time between them already worked out.'
			},
			{
				title: 'Split the group',
				body: 'Run parallel tracks when half the group wants the museum and half wants the beach.'
			},
			{
				title: 'Pick where to sleep',
				body: 'Put the options up with a nightly price, let the group vote, then book the nights on the schedule.'
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
		body: 'The address may be mistyped, or what was here has been deleted.',
		backAnonymous: 'Back to the start'
	},

	// Trips list, the signed-in home page
	trips: {
		heading: 'Your trips',
		cityCount: (cities: number) => `${cities} ${cities === 1 ? 'city' : 'cities'}`,
		memberCount: (members: number) => `${members} ${members === 1 ? 'person' : 'people'}`,
		newDialog: {
			title: 'Add trip',
			fallback: 'Could not create the trip.'
		}
	},

	// Trip form, shared by the Add trip and Edit trip dialogs
	tripForm: {
		nameLabel: 'Name',
		startLabel: 'Start',
		endLabel: 'End',
		currencyLabel: 'Currency',
		currencyAriaLabel: 'Home currency',
		tooLong: 'A trip can run for at most a year.'
	},

	// Trip shell > header, edit dialog, live-updates notice
	tripShell: {
		notFound: 'Trip not found.',
		/** Toasted when a trip this tab had open is deleted or the reader is removed from it. */
		gone: 'That trip is no longer available.',
		editTrip: 'Edit trip',
		editDialog: {
			title: 'Edit trip',
			fallback: 'Could not save that trip.',
			/** The schedule lock. The switch says what it does; nothing else needs to. */
			lockLabel: 'Lock schedule',
			lockFooter: 'Prevents schedule edits until it is unlocked.'
		},
		leaveTrip: 'Leave trip',
		leaveDialog: {
			title: (trip: string) => `Leave ${trip}?`
		},
		liveOff: "Live updates are off, so you will not see other people's changes.",
		reconnect: 'Reconnect'
	},

	// Add city dialog, reached from Discover
	addCity: {
		title: 'Add city',
		addFallback: 'Could not add that city.',
		searchLabel: 'City',
		searchPlaceholder: 'Kyoto, Lisbon, Cusco...',
		searching: 'Searching...',
		noMatches: 'No cities matched that.',
		alreadyAdded: 'Added'
	},

	// Discover > city sidebar, location and stay cards, add and edit dialogs
	discover: {
		types: {
			all: 'All',
			attraction: 'Attractions',
			food: 'Food & Drinks',
			stay: 'Stays'
		},
		noCities: {
			heading: 'No cities yet',
			body: 'Add a city to start planning.',
			cta: 'Add city',
			memberNote: 'Waiting for an organizer to add the first stop...'
		},
		cityList: {
			navLabel: 'Cities',
			addCity: 'Add city',

			lastCityTitle: 'A trip needs at least one city',
			/**
			 * A city with its region when it has one. The region is set only when a
			 * same-named city is already on the trip, so most cities are just their
			 * name. Shared because the sidebar row, the narrow dropdown and the
			 * delete confirmation all have to name a city the same way.
			 */
			cityLabel: (city: string, region?: string | null) => (region ? `${city}, ${region}` : city)
		},
		header: {
			typeAriaLabel: 'Type',
			add: 'Add'
		},
		deletePlace: {
			/** Asked instead when the location is on the calendar and takes events with it. */
			linkedTitle: (place: string, linked: number) =>
				`Delete ${place} and ${linked} event${linked === 1 ? '' : 's'}?`
		},
		deleteStay: {
			/** Asked instead when the stay is booked on the calendar and takes its nights with it. */
			linkedTitle: (stay: string, linked: number) =>
				`Delete ${stay} and ${linked} booked night${linked === 1 ? '' : 's'}?`
		},
		errors: {
			votePlace: 'Could not vote on that location.',
			voteStay: 'Could not vote on that stay.'
		},
		card: {
			voteLabel: (youVoted: boolean, subject: string) =>
				`${youVoted ? 'Remove your vote from' : 'Vote for'} ${subject}`,
			openLabel: (name: string) => `Open ${name} (opens in a new tab)`
		},
		stayCard: {
			priceTbd: 'Price TBD'
		},
		placeFields: {
			typeLabel: 'Type',
			typeAriaLabel: 'Type',
			notesLabel: 'Notes',
			linkLabel: 'Link',
			linkPlaceholder: 'https://'
		},
		addDialog: {
			title: 'Add location',
			nameLabel: 'Name',
			keepTyping: 'Keep typing to search.',
			searching: 'Searching...',
			noMatches: (query: string) => `No matches for "${query}". Add it by hand instead.`,
			attribution: (provider: string) => `Powered by ${provider}`,
			providerGoogle: 'Google Maps',
			providerOsm: 'OpenStreetMap',
			notThisOne: 'Not this one',
			priceLabel: 'Price / night',
			currencyLabel: 'Currency',
			activityLabel: 'Activity',
			badPrice: 'Enter a valid price, or leave it blank.',
			fallback: 'Could not add that location.'
		},
		editPlace: {
			title: 'Edit location',
			nameLabel: 'Name',
			votes: (votes: number) => (votes === 1 ? '1 vote' : `${votes} votes`),
			voters: (voters: readonly string[]) =>
				voters.length ? `: ${voters.join(', ')}` : ', nobody yet',
			fallback: 'Could not save that location.'
		},
		editStay: {
			title: 'Edit stay',
			nameLabel: 'Name',
			priceLabel: 'Price / night',
			currencyLabel: 'Currency',
			badPrice: 'Enter a valid price, or leave it blank.',
			fallback: 'Could not save that stay.'
		}
	},

	// Native Discover helpers
	mobileDiscover: {
		editCityTitle: 'Edit city',
		editCityButton: 'Edit city',
		deleteCityMessage: (linked: number) =>
			linked > 0
				? `This also deletes the city's places and stays, plus ${linked} linked calendar item${linked === 1 ? '' : 's'}.`
				: `This also deletes the city's places and stays.`,
		shortTypes: {
			attraction: 'Attractions',
			food: 'Food'
		},
		ratingLabel: (rating: string, count?: number | null) =>
			count ? `Rating ${rating} (${count})` : `Rating ${rating}`,
		openLink: 'Open'
	},

	// Preparation > tasks, packing list, cost estimates
	preparation: {
		navAriaLabel: 'Preparation sections',
		sections: { tasks: 'Tasks', packing: 'Packing', costs: 'Estimated costs' },
		add: 'Add',
		tripTotal: 'Trip total',
		perPerson: 'Per person',
		youSuffix: ' (you)',
		saveFallback: 'Could not save that.',
		myTasks: {
			title: 'Assigned to you',
			othersTitle: 'Other tasks'
		},
		taskList: {
			sharedBoxLabel: (done: boolean, label: string) =>
				`${done ? 'Mark not done' : 'Mark done'}: ${label}`,
			allBoxLabel: (done: boolean, label: string) =>
				`${done ? 'Mark not done for everyone' : 'Mark done for everyone'}: ${label}`,
			doneSummary: (done: number, total: number) => `${done}/${total} done`,
			doneMenuLabel: (label: string) => `Who has finished: ${label}`,
			editLabel: (kind: string, label: string) => `Edit ${kind}: ${label}`
		},
		taskDialog: {
			title: (kind: 'task' | 'packing', editing: boolean) =>
				`${editing ? 'Edit' : 'Add'} ${kind === 'packing' ? 'packing item' : 'task'}`,
			labelField: 'Name',
			assignLabel: 'Assigned to',
			assignPlaceholder: 'Anyone',
			noMembers: 'No members yet.',
			selectEveryone: 'Select everyone',
			clear: 'Clear',
			fallback: 'Could not save that.'
		},
		costTable: {
			sectionLabel: (category: string) => `${category} estimates`,
			ofTotal: (total: string) => `of ${total}`,
			total: 'Total'
		},
		costDialog: {
			editTitle: 'Edit cost',
			addTitle: 'Add cost',
			labelField: 'Description',
			amountLabel: 'Amount',
			currencyLabel: 'Currency',
			categoryLabel: 'Category',
			forLabel: 'For',
			forEveryone: EVERYONE,
			fallback: 'Could not save that item.'
		}
	},

	// Schedule > the board, its day navigation, and the two event dialogs
	schedule: {
		views: { day: 'Day', agenda: 'Agenda' },
		viewAriaLabel: 'Schedule view',
		nav: {
			previousDay: 'Previous day',
			nextDay: 'Next day',
			jumpToDate: 'Jump to a date'
		},
		block: {
			/** The grip on a block's bottom edge, which is a drag and not a button. */
			resizeLabel: 'Drag to change the end time',
			/** What pressing a block does, which depends on whether it can be moved. */
			moveLabel: 'Show on the map, or drag to reschedule.',
			mobileOpenLabel: 'Open event details, or long press to reschedule.',
			openLabel: 'Show the details.'
		},
		addStay: '+ Add stay',
		add: '+ Add',
		viewAsAriaLabel: 'View the schedule as',
		/**
		 * The frozen board. The tag replaces the Add button rather than sitting
		 * beside it, because the point is that there is nothing to press: an
		 * explanation under a button that still looks live reads as a bug.
		 */
		lock: {
			tag: 'Locked',
			hint: 'Locked by the organizer, who can unlock it from Edit trip'
		},
		/** The two event dialogs share every field, so they share one set of labels. */
		fields: {
			type: 'Type',
			when: 'When',
			start: 'Start',
			end: 'End',
			mode: 'Mode',
			date: 'Date',
			checkIn: 'Check in',
			checkOut: 'Check out',
			label: 'Label',
			notes: 'Notes',
			participants: 'Participants',
			/** Shown when nobody is picked, which the board reads as everyone. */
			nobody: 'Nobody'
		},
		mobile: {
			stays: 'Stays',
			firstDay: 'First day',
			lastDay: 'Last day',
			freeDay: 'This day is free.'
		},
		map: {
			title: 'Map',
			backToDay: 'Back to day',
			hide: 'Hide',
			show: 'Show',
			webFallback: 'Map preview is available in Expo Go. Pins are listed here for web preview.'
		},
		/** The event dialog's title: reading a frozen block, editing one, adding one. */
		dialog: { view: 'Event', edit: 'Edit event', add: 'Add event' },
		/** A journey card's own fields; the mode reuses `fields.mode`. */
		journey: {
			heading: 'Getting here',
			name: 'Journey name',
			minutes: 'Minutes',
			minutesUnit: 'min',
			automatic: 'Automatic',
			estimate: (minutes: number) => `${minutes}m`
		},
		eventSaveFallback: 'Could not save that event.',
		eventAddFallback: 'Could not add that event.',
		eventDeleteFallback: 'Could not delete that event.',
		/**
		 * What the place search says instead of a list of results. Five states, not
		 * one: a search in flight, a query too short to send, a search that came
		 * back with nothing, and a local list with no match all mean different
		 * things to somebody waiting for a name to appear.
		 */
		placeSearch: {
			searching: 'Searching...',
			keepTyping: 'Keep typing to search.',
			nothingFound: 'Nothing found.',
			noMatch: 'No match.'
		}
	},

	// Expenses > ledger, balances, settle up
	expenses: {
		navAriaLabel: 'Expense sections',
		sections: { expenses: 'Expenses', balances: 'Balances', settle: 'Settle up' },
		addExpense: 'Add',
		tripTotal: 'Trip total',
		perPerson: 'Per person',
		/** Empty-state captions carry no full stop, the same as `common.nothingAdded`. */
		allEven: 'Everyone is even',
		youTag: 'you',
		formerTag: 'left the trip',
		nothingToSettle: 'Nothing to settle',
		noneForMember: (who: string) => `Nothing here for ${who}`,
		row: {
			paymentTag: 'payment',
			incomeTag: 'income',
			received: 'received',
			paid: 'paid',
			ofTotal: (total: string) => `of ${total}`,
			splitLabel: (mode: string, participants: number) => {
				const people = `${participants} ${participants === 1 ? 'way' : 'ways'}`;
				if (mode === 'shares') return `split by shares, ${people}`;
				if (mode === 'exact') return `split by amount, ${people}`;
				return `split ${people}`;
			},
			openLabel: (description: string) => `Open ${description}`,
			reviewShort: 'Review',
			reviewTitle: 'Someone on this expense has left the trip. Edit it to reassign their share.'
		},
		settleRow: {
			pays: 'pays',
			busyLabel: 'Saving...',
			markPaid: 'Mark paid',
			markPaidLabel: (from: string, to: string, amount: string) =>
				`Record that ${from} paid ${to} ${amount}`,
			fallback: 'Could not record that payment.'
		},
		addDialog: {
			modes: {
				even: { label: 'Evenly' },
				shares: { label: 'By shares' },
				exact: { label: 'By amount' }
			},
			incomeTitle: 'Add income',
			expenseTitle: 'Add expense',
			editIncomeTitle: 'Edit income',
			editExpenseTitle: 'Edit expense',
			kindExpense: 'Expense',
			kindIncome: 'Income / refund',
			descriptionLabel: 'Description',
			dateLabel: 'Date',
			amountLabel: 'Amount',
			currencyLabel: 'Currency',
			receivedByLabel: 'Received by',
			paidByLabel: 'Paid by',
			incomeNote: 'Saved as income: everyone selected is credited instead of charged.',
			expenseNote: 'Use a negative amount for a refund or payout.',
			mobileExpenseNote: 'Saved as an expense: everyone selected is charged.',
			splitLabel: 'Split',
			splitAriaLabel: 'Split method',
			selectedCount: (chosen: number, members: number) => `${chosen} of ${members} selected`,
			fullyAllocated: ' · fully allocated',
			remainder: (amount: string, left: boolean) => ` · ${amount} ${left ? 'left' : 'over'}`,
			fullyAllocatedMobile: 'Fully allocated',
			remainderMobile: (amount: string, left: boolean) => `${amount} ${left ? 'left' : 'over'}`,
			splitTheRest: 'Split the rest',
			all: 'All',
			none: 'None',
			weightLabel: (exact: boolean, name: string) => `${exact ? 'Amount' : 'Shares'} for ${name}`,
			fewerShares: (name: string) => `One share fewer for ${name}`,
			moreShares: (name: string) => `One share more for ${name}`,
			fallback: 'Could not save that expense.'
		}
	},

	// People > roster, crews, their dialogs and removal confirmation
	people: {
		membersHeading: 'Members',
		navAriaLabel: 'People sections',
		row: {
			sampleCompanion: 'Sample companion',
			youTag: 'you',
			organizerTag: 'organizer',
			invitedTag: 'invited',
			sampleTag: 'sample'
		},
		edit: {
			title: 'Edit person',
			nameLabel: 'Display name',
			emailLabel: 'Email',
			fallback: 'Could not save that person.'
		},
		add: {
			title: 'Add person',
			nameLabel: 'Display name',
			emailLabel: 'Email',
			fallback: 'Could not add that person.'
		},
		crews: {
			heading: 'Crews',
			nobody: 'Nobody yet',
			memberCount: (members: number) => `${members} ${members === 1 ? 'person' : 'people'}`,
			locked: 'Locked',
			addTitle: 'Add crew',
			editTitle: 'Edit crew',
			nameLabel: 'Name',
			peopleLabel: 'People',
			peopleAriaLabel: 'Crew members',
			fallback: 'Could not save that crew.'
		}
	},

	// Account settings > profile and password
	account: {
		heading: 'Account settings',
		profile: {
			heading: 'Profile',
			saved: 'Profile saved.',
			nameLabel: 'Name',
			emailLabel: 'Email',
			/** Asked for only once the email field differs from the address on file. */
			currentPasswordLabel: 'Current password',
			/** The address does not change until the link sent to the new one is opened. */
			emailPending: (email: string) => `We sent a confirmation link to ${email}.`,
			timeZoneLabel: 'Home time zone',
			timeZoneAriaLabel: 'Home time zone',
			timeZoneNoMatches: 'No time zones matched that.',
			fallback: 'Could not save your profile.'
		},
		password: {
			heading: 'Password',
			change: 'Change password',
			updated: 'Password updated.',
			currentLabel: 'Current password',
			newLabel: 'New password',
			newHint: 'At least 8 characters',
			confirmLabel: 'Confirm new password',
			fallback: 'Could not change your password.'
		}
	},

	// Shared UI components > defaults and accessible names
	ui: {
		modal: { closeLabel: 'Close' },
		confirmDialog: {
			undone: 'Are you sure? This action cannot be undone.',
			fallback: 'Could not complete that.'
		},
		searchDropdown: { busyLabel: 'Searching...' },
		searchPlaceholder: 'Search',
		currencyPicker: { noMatches: 'No currencies matched that.' },
		select: { placeholder: 'Select...', ariaLabel: 'Select' },
		form: {
			missing: 'Fill in every field.',
			badEmail: 'Enter a valid email address.'
		},
		multiSelect: {
			placeholder: 'Anyone',
			ariaLabel: 'Assign people',
			summaryLabel: (count: number) => `${count} people`,
			empty: 'No members yet',
			groupsHeading: 'Crews',
			optionsHeading: 'People'
		},
		sectionNav: { ariaLabel: 'Sections' },
		field: { optionalSuffix: ' (optional)' },
		tripMap: {
			failed: 'Could not draw the map.'
		},
		mapCard: {
			/** Carries the plus, like every other add in the app. */
			add: '+ Add',
			savedLocation: 'Saved location',
			votes: (count: number) => `${count} ${count === 1 ? 'vote' : 'votes'}`
		}
	},

	// Shared API client and hooks > fallbacks used when the server sends none
	api: {
		unreachable: 'Could not reach the server. Check your connection.',
		requestFailed: 'Could not complete that. Try again.',
		loadFailed: 'Could not load this page.',
		retry: 'Try again',
		saveFallback: 'Could not save that.'
	},

	// Generic control labels reused across unrelated surfaces
	common: {
		add: 'Add',
		cancel: 'Cancel',
		/**
		 * The verbs a confirmation offers. A confirm button repeats the verb its
		 * title asked with and nothing else: "Delete Athens?" is answered by
		 * "Delete", never by "Delete city". The title already named the thing.
		 *
		 * Every destructive button in the app says `delete`, including the one
		 * that takes a person off a trip. `leave` is the one exception, because
		 * leaving a trip is a different act from deleting it and the two sit side
		 * by side.
		 */
		delete: 'Delete',
		leave: 'Leave',
		more: 'More',
		/** Every save button says this. The dialog title already names the thing. */
		save: 'Save',
		saving: 'Saving...',
		deleting: 'Deleting...',
		adding: 'Adding...',
		working: 'Working...',
		/** A delete confirmation names the thing in its title and asks nothing else. */
		deleteTitle: (name: string) => `Delete ${name}?`,
		/**
		 * The pencil and the bin beside a row, wherever the row sits. Both are
		 * drawn, so this is the whole of what a screen reader gets, and the name
		 * has to be in it or every row on the page reads alike.
		 */
		editLabel: (name: string) => `Edit ${name}`,
		deleteLabel: (name: string) => `Delete ${name}`,
		/** Every list that you fill by adding to it says this when it is empty. */
		nothingAdded: 'Nothing added yet',
		/** What a page says while its first load is in flight. */
		loading: 'Loading...',
		amountMissing: 'Enter an amount.',
		/** The way back to the trip list, wherever it is offered. */
		allTrips: 'All trips',
		everyone: EVERYONE
	},

	// Shared by the money lists: estimated costs and the expense ledger
	viewAs: {
		label: 'View as',
		everyone: EVERYONE,
		yourShare: 'Your share',
		share: (name: string) => `${name}'s share`,
		/**
		 * What the warning mark beside a name means. The mark is drawn, not
		 * written, so this is its accessible name and its tooltip, in one place:
		 * a triangle that says one thing in the menu and another on the board
		 * would be two marks wearing the same face. It reads as something said
		 * about the person or the journey it sits beside, which "Does not fit the
		 * gap" did not: that described the gap, not them.
		 */
		travelWarning: 'Not enough time to get there'
	}
} as const;
