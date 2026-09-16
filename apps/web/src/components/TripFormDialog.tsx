import { useState, type ReactNode } from 'react';
import { useMutation } from '../hooks/useMutation';
import { CURRENCY_CODES } from '../lib/currencies';
import { nightsBetween } from '../lib/format';
import Modal, { ModalFooter, ModalForm } from './ui/Modal';
import CurrencyPicker from './ui/CurrencyPicker';
import { Field } from './ui/Field';
import { copy } from '../copy';

const c = copy.tripForm;

/**
 * The longest range this form will write, in days, counting both endpoints.
 *
 * A year, because the schedule draws one column per day and steps through them
 * a day at a time: a trip entered as 2024 to 2026 produced four hundred columns
 * and no way to reach the middle of them, which is how this bound came to be
 * needed. The real fix is a date picker on the schedule's day stepper, and a
 * matching rule in `validateDates` on the server so that no other writer can
 * create one either. Until both exist, the form is where a typed year can be
 * caught, and one year is generous for a group trip while still being a range
 * anyone can navigate.
 */
const MAX_DAYS = 366;

/** Days from start to end inclusive, or null when the range is not a real one. */
function spanDays(start: string, end: string): number | null {
	if (!start || !end) return null;
	if (start === end) return 1;
	const nights = nightsBetween(start, end);
	return nights === null ? null : nights + 1;
}

export type TripFormValues = {
	name: string;
	/** 'YYYY-MM-DD'. Both ends are required; the server is what enforces it. */
	startDate: string;
	endDate: string;
	currency: string;
};

/**
 * The trip form, for both creating one and editing one.
 *
 * These were two components that differed in four strings, four initial values
 * and one API call, and agreed on everything else: the field layout, the
 * optional-date rules, the busy/error wiring and the footer. Two copies meant
 * two places to fix the next bug in any of that, and they had already drifted
 * (one marked the name `required`, the other did not, so the same empty name
 * produced a native browser tooltip in one dialog and the server's sentence in
 * the other).
 *
 * Deliberately has no `mode` prop. Everything that actually differs arrives as
 * a value, including the whole write as `onSubmit`, so there is no branch in
 * here to read: the create caller POSTs and navigates, the edit caller PATCHes
 * and closes, and neither one is this component's business. That also keeps the
 * wire asymmetry (`homeCurrency` on create, `currency` on edit) where it
 * belongs, in the caller that knows which endpoint it is talking to.
 */
export default function TripFormDialog({
	title,
	submitLabel,
	busyLabel,
	initial,
	fallback,
	footerStart,
	onSubmit,
	onClose
}: {
	title: string;
	submitLabel: string;
	/** Shown on the submit button while the write is in flight. */
	busyLabel: string;
	/** Omitted fields start empty, which is what the create case wants. */
	initial?: Partial<TripFormValues>;
	/** Used when the failure is not an ApiError. */
	fallback?: string;
	/**
	 * Rendered at the left of the footer, away from Save. For an action that
	 * belongs to the thing being edited rather than to the form: editing a trip
	 * is where you go to delete it, and creating one has nothing to put here.
	 */
	footerStart?: ReactNode;
	onSubmit: (values: TripFormValues) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(initial?.name ?? '');
	const [startDate, setStartDate] = useState(initial?.startDate ?? '');
	const [endDate, setEndDate] = useState(initial?.endDate ?? '');
	const [currency, setCurrency] = useState(initial?.currency ?? 'USD');

	const save = useMutation(() => onSubmit({ name, startDate, endDate, currency }), { fallback });

	/**
	 * The range this dialog opened on, so an existing over-long trip can still be
	 * renamed or re-dated. The bound is new; the trips in the database are not,
	 * and a rule that locked somebody out of editing a trip they already have is
	 * a worse bug than the one it fixes. It refuses only a range that is both
	 * over the bound and longer than what was there before.
	 */
	const wasSpan = spanDays(initial?.startDate ?? '', initial?.endDate ?? '') ?? 0;

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const span = spanDays(startDate, endDate);
		if (span !== null && span > MAX_DAYS && span > wasSpan) {
			// COPY: pending owner clearance, wanted as `copy.tripForm.tooLong`.
			return save.setError('A trip can run for at most a year.');
		}
		void save.run();
	}

	return (
		<Modal open title={title} size="sm" onClose={onClose}>
			{/* Nothing here is marked `required` and native validation is off: every
			    rule (a missing date, end-before-start, which `min` below can only
			    hint at) belongs to the server, whose wording is the one the user
			    should see. A native constraint would block the submit and that
			    message would never arrive. The one exception is the length bound,
			    which the server does not have yet and which `submit` checks here. */}
			<ModalForm onSubmit={submit}>
				<div className="mbody flex flex-col gap-3">
					<Field label={c.nameLabel} value={name} onChange={(e) => setName(e.target.value)} />
					<div className="flex flex-wrap gap-2.5">
						<Field
							label={c.startLabel}
							className="flex-[1_1_130px]"
							type="date"
							value={startDate}
							onChange={(e) => setStartDate(e.target.value)}
						/>
						<Field
							label={c.endLabel}
							className="flex-[1_1_130px]"
							type="date"
							// A native affordance only, and deliberately inclusive: a trip
							// that starts and ends on the same day is a real one.
							min={startDate || undefined}
							value={endDate}
							onChange={(e) => setEndDate(e.target.value)}
						/>
						<CurrencyPicker
							className="flex-[0_1_130px]"
							label={c.currencyLabel}
							ariaLabel={c.currencyAriaLabel}
							// The offline codes, not a server list: the home currency is what
							// everything else converts into, so it stays the set that can be
							// converted without the network.
							codes={CURRENCY_CODES}
							value={currency}
							onChange={setCurrency}
						/>
					</div>
				</div>
				<ModalFooter
					start={footerStart}
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={busyLabel}
					submitLabel={submitLabel}
				/>
			</ModalForm>
		</Modal>
	);
}
