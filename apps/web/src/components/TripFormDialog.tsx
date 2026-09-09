import { useState } from 'react';
import { useMutation } from '../hooks/useMutation';
import { currencyOptions } from '../lib/currencies';
import Modal from './ui/Modal';
import Select from './ui/Select';
import FormError from './ui/FormError';
import { Field, FieldShell } from './ui/Field';

export type TripFormValues = {
	name: string;
	/** 'YYYY-MM-DD', or '' for "not set". Both ends are optional. */
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
	note,
	initial,
	fallback,
	onSubmit,
	onClose
}: {
	title: string;
	submitLabel: string;
	/** Shown on the submit button while the write is in flight. */
	busyLabel: string;
	/** The line under the fields, which says different true things per caller. */
	note: string;
	/** Omitted fields start empty, which is what the create case wants. */
	initial?: Partial<TripFormValues>;
	/** Used when the failure is not an ApiError. */
	fallback?: string;
	onSubmit: (values: TripFormValues) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(initial?.name ?? '');
	const [startDate, setStartDate] = useState(initial?.startDate ?? '');
	const [endDate, setEndDate] = useState(initial?.endDate ?? '');
	const [currency, setCurrency] = useState(initial?.currency ?? 'USD');

	const save = useMutation(() => onSubmit({ name, startDate, endDate, currency }), { fallback });

	return (
		<Modal open title={title} size="sm" onClose={onClose}>
			{/* Nothing here is `required`, and native validation is off entirely:
			    both dates are genuinely optional, and every rule about them
			    (including end-before-start, which `min` below can only hint at)
			    belongs to the server, whose wording is the one the user should see.
			    A native constraint would block the submit and that message would
			    never arrive. */}
			<form className="mform" noValidate onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-3">
					<FormError message={save.error} variant="banner" className="mb-0" />
					<Field label="Trip name" value={name} onChange={(e) => setName(e.target.value)} />
					<div className="flex flex-wrap gap-2.5">
						<Field
							label="Start"
							optional
							className="flex-[1_1_130px]"
							type="date"
							value={startDate}
							onChange={(e) => setStartDate(e.target.value)}
						/>
						<Field
							label="End"
							optional
							className="flex-[1_1_130px]"
							type="date"
							// A native affordance only, and deliberately inclusive: a trip
							// that starts and ends on the same day is a real one.
							min={startDate || undefined}
							value={endDate}
							onChange={(e) => setEndDate(e.target.value)}
						/>
						<FieldShell label="Currency" className="flex-[0_1_130px]">
							<Select
								ariaLabel="Home currency"
								value={currency}
								onChange={setCurrency}
								options={currencyOptions()}
							/>
						</FieldShell>
					</div>
					<p className="muted m-0 text-[0.78rem] leading-relaxed">{note}</p>
				</div>
				<div className="mfoot">
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={save.busy}>
						{save.busy ? busyLabel : submitLabel}
					</button>
				</div>
			</form>
		</Modal>
	);
}
