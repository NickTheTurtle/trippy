import EmptyState from './EmptyState';
import { copy } from '../../copy';

/**
 * What a page shows while its first GET is still in flight.
 *
 * Six pages answered this six ways: four returned null and flashed blank when
 * you navigated into a trip, Account printed a grey line, and the trips grid
 * simply stayed empty. Nothing was wrong with any one of them; having six was.
 *
 * A line of text, not a spinner and not a skeleton, and it is the same centred
 * panel the page already uses to say a list is empty or that the load failed.
 * The three states a page can be in before it has content then have one shape,
 * so arriving, failing and finding nothing do not each resize the page.
 *
 * A skeleton would read better, but it means a bespoke shape per page (a card
 * grid, a ledger, a roster, a task list, a cost table), and five drawings that
 * have to be kept in step with five layouts is five more things to go stale. A
 * spinner is a moving part that says less than the word does, and would be the
 * app's only animation of its kind. The word is announced by a screen reader,
 * needs no stylesheet, and is what Account was already doing.
 *
 * Only ever for the *first* load. `useApi` keeps the previous data through a
 * reload on purpose, so an edit-and-save cycle never falls back to this.
 */
export default function Loading({ className = '' }: { className?: string }) {
	return (
		// `status` rather than `alert`: waiting is not an interruption, and the
		// page that follows is the real answer.
		<div role="status" className={className}>
			{/* COPY: this string is filed under `account` because Account was the
			    one page that had it. Wanted as `copy.common.loading` once cleared,
			    now that every page says it. */}
			<EmptyState message={copy.account.loading} />
		</div>
	);
}
