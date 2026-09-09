/** The shape of `GET /trips/:id/people`: the roster, and what the reader may do to it. */
export type Person = {
	id: string;
	name: string;
	email: string;
	role: string;
	placeholder: boolean;
	seeded: boolean;
};

export type PeopleData = { me: string; organizer: boolean; people: Person[] };
