import Avatar from '../../components/ui/Avatar';
import UiTag from '../../components/ui/Tag';
import type { Person } from './types';
import { copy } from '../../copy';

const c = copy.people.row;

/**
 * One member of the roster.
 *
 * The row opens the person: their name and invite address if the trip owns
 * them, and the button that takes them off the trip. A row nobody can act on,
 * which is any row at all when you are not the organizer, is not a button and
 * does not pretend to be one.
 */
export default function MemberRow({
	person,
	me,
	onOpen
}: {
	person: Person;
	me: string;
	/** Null when there is nothing this reader may do to this person. */
	onOpen: (() => void) | null;
}) {
	// An invited member's address is the one they were invited at, not the
	// synthetic placeholder address; the server already resolves that, and
	// returns nothing at all for somebody added by name alone.
	const sub = person.seeded ? c.sampleCompanion : person.email;
	// Your own name is your account's, but it is still yours to change from
	// here, so your row reads as an edit like any other editable one.
	const editable = person.placeholder || person.seeded || person.id === me;

	const body = (
		<>
			{/* Aligned to the top, not centred. The eye pairs a face with the name
			    beside it, and centring hung it between the name and the address, a
			    row's tags wrapping on a phone dropped it further still. */}
			<Avatar name={person.name} size="lg" />
			<span className="flex min-w-0 flex-1 flex-col">
				{/* The tags wrap below the name rather than squeezing it: on a phone
				    two of them left "Demo T..." on a row with room to spare on the
				    line beneath. */}
				<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-medium">
					<span className="truncate" title={person.name}>
						{person.name}
					</span>
					{person.id === me && <Tag kind="you">{c.youTag}</Tag>}
					{person.role === 'organizer' && <Tag kind="org">{c.organizerTag}</Tag>}
					{/* "Invited" only when there is an invite out. Somebody added by
					    name alone is on the trip and waiting for nothing, so a tag
					    that said they were would be describing a mail nobody sent. */}
					{person.placeholder ? (
						person.invitedEmail ? (
							<Tag kind="invited">{c.invitedTag}</Tag>
						) : null
					) : (
						person.seeded && <Tag kind="seed">{c.sampleTag}</Tag>
					)}
				</span>
				{sub && <span className="muted truncate text-meta">{sub}</span>}
			</span>
		</>
	);

	const shell = 'flex w-full items-start gap-3 rounded-sm p-2 text-left text-body';

	return (
		<li>
			{onOpen ? (
				<button
					type="button"
					onClick={onOpen}
					aria-label={
						editable ? copy.common.editLabel(person.name) : copy.common.deleteLabel(person.name)
					}
					className={`${shell} cursor-pointer border-0 bg-transparent hover:bg-surface-2`}
				>
					{body}
				</button>
			) : (
				<div className={shell}>{body}</div>
			)}
		</li>
	);
}

function Tag({ kind, children }: { kind: 'you' | 'org' | 'seed' | 'invited'; children: string }) {
	const { tone, outline } = {
		org: { tone: 'accent', outline: false },
		you: { tone: 'neutral', outline: false },
		seed: { tone: 'neutral', outline: true },
		invited: { tone: 'accent', outline: true }
	}[kind] as { tone: 'accent' | 'neutral'; outline: boolean };
	return (
		<UiTag tone={tone} outline={outline}>
			{children}
		</UiTag>
	);
}
