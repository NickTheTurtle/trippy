import { LinkButton } from '../../components/ui/buttons';
import type { Person } from './types';
import { copy } from '../../copy';

const c = copy.people.row;

/** One member of the roster, with the remove control an organizer sees. */
export default function MemberRow({
	person,
	me,
	organizer,
	onRemove
}: {
	person: Person;
	me: string;
	organizer: boolean;
	onRemove: () => void;
}) {
	const sub = person.placeholder
		? c.notJoined(person.email)
		: person.seeded
			? c.sampleCompanion
			: person.email;

	return (
		<li className="flex items-center gap-3 rounded-sm p-2 hover:bg-surface-2">
			<span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent-ink">
				{person.name[0]}
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5 font-medium">
					<span className="truncate" title={person.name}>
						{person.name}
					</span>
					{person.id === me && <Tag kind="you">{c.youTag}</Tag>}
					{person.role === 'organizer' && <Tag kind="org">{c.organizerTag}</Tag>}
					{person.placeholder ? (
						<Tag kind="invited">{c.invitedTag}</Tag>
					) : (
						person.seeded && <Tag kind="seed">{c.sampleTag}</Tag>
					)}
				</span>
				<span className="muted truncate text-[0.82rem]">{sub}</span>
			</span>
			{organizer && person.role !== 'organizer' && (
				/* A text control rather than a bordered button: on every row of a
				   two-column roster a button would read as the row's main action,
				   which it is not. The weight belongs in the confirmation. */
				<LinkButton
					danger
					className="flex-none"
					onClick={onRemove}
					aria-label={c.removeLabel(person.name)}
				>
					{c.remove}
				</LinkButton>
			)}
		</li>
	);
}

function Tag({ kind, children }: { kind: 'you' | 'org' | 'seed' | 'invited'; children: string }) {
	const style = {
		org: 'bg-accent-soft text-accent-ink',
		you: 'bg-line text-ink-soft',
		seed: 'border border-line text-ink-faint',
		invited: 'border border-accent-soft text-accent-ink'
	}[kind];
	return (
		<span
			className={`shrink-0 rounded-full px-1.5 py-px text-[0.68rem] font-semibold tracking-wider uppercase ${style}`}
		>
			{children}
		</span>
	);
}
