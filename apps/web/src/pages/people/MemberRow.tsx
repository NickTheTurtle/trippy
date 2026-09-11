import { IconButton } from '../../components/ui/buttons';
import { PencilIcon, TrashIcon } from '../../components/ui/icons';
import Avatar from '../../components/ui/Avatar';
import UiTag from '../../components/ui/Tag';
import type { Person } from './types';
import { copy } from '../../copy';

const c = copy.people.row;

/** One member of the roster, with the controls an organizer sees. */
export default function MemberRow({
	person,
	me,
	organizer,
	onEdit,
	onRemove
}: {
	person: Person;
	me: string;
	organizer: boolean;
	/** Null when this person's name is their own account's, not the trip's. */
	onEdit: (() => void) | null;
	onRemove: () => void;
}) {
	// An invited member's address is the one they were invited at, not the
	// synthetic placeholder address; the server already resolves that, and
	// returns nothing at all for somebody added by name alone.
	const sub = person.seeded ? c.sampleCompanion : person.email;

	return (
		<li className="group flex items-center gap-3 rounded-sm p-2 hover:bg-surface-2">
			<Avatar name={person.name} size="lg" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5 font-medium">
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
			{/* The same drawn pencil and bin every other list in the app uses, on the
			    row's hover, so removing a member is not the loudest thing on a page
			    that is mostly about who is coming. */}
			<span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
				{organizer && onEdit && (
					<IconButton label={c.editLabel(person.name)} onClick={onEdit}>
						<PencilIcon />
					</IconButton>
				)}
				{organizer && person.role !== 'organizer' && (
					<IconButton label={c.removeLabel(person.name)} danger onClick={onRemove}>
						<TrashIcon />
					</IconButton>
				)}
			</span>
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
