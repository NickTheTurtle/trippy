import { WarningIcon } from './icons';

/**
 * The mark that says a plan needs a person to look at it.
 *
 * Drawn rather than written, because the same fact is reported in four places
 * that have no room for a sentence: a dropdown row, a journey card, an agenda
 * line and a map pin. A phrase in one of them and a triangle in the others read
 * as two different problems.
 *
 * It carries the words as its accessible name and as its tooltip, so a reader
 * who cannot see the triangle and one who does not yet know what it means both
 * get them. The label is passed in rather than fixed here: the mark means "look
 * at this", and what there is to look at belongs to the caller.
 */
export default function WarnMark({ label }: { label: string }) {
	return (
		<span className="warnmark" role="img" aria-label={label} title={label}>
			<WarningIcon />
		</span>
	);
}
