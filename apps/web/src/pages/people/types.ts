/** The shape of `GET /trips/:id/people`: the roster, and what the reader may do to it. */
export type Person = {
	id: string;
	name: string;
	email: string;
	role: string;
	placeholder: boolean;
	seeded: boolean;
	/** The address an invite was sent to, for a placeholder that has one. */
	invitedEmail?: string | null;
};

export type PeopleData = { me: string; organizer: boolean; people: Person[]; crews: Crew[] };

/**
 * A saved group of people.
 *
 * Managed on this page and read by the schedule's people picker, which is why
 * the type lives here rather than beside the board: a crew is a fact about the
 * roster, and the picker only borrows it.
 */
export type Crew = {
	id: string;
	name: string;
	color: string;
	members: string[];
	/** True for Everyone, which the server derives from the roster and nobody may change. */
	locked: boolean;
};
