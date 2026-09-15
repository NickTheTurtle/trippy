import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import { Field, FieldShell } from '../../components/ui/Field';
import Select from '../../components/ui/Select';
import { currencyOptions } from '../../lib/currencies';
import { parseMoneyToCents } from '../../lib/format';
import type { Stay } from '../../lib/api-types';
import { LinkField, NotesField } from './place-fields';
import { copy } from '../../copy';

const c = copy.discover.editStay;

/**
 * Edit a proposed stay.
 *
 * Everything the proposer typed, and nothing else. Votes and the lock are not
 * shown or touched: a corrected price is the same stay, and the alternative to
 * editing was deleting and re-proposing, which threw the group's votes away
 * over a typo.
 *
 * The night range is here rather than only on the calendar because it is what
 * a nightly price multiplies out against, so the two belong on one form.
 * Currency sits beside the price, because a stay abroad is quoted in the local
 * currency and converting it by hand before typing it loses the real number.
 */
export default function EditStayDialog({
	base,
	stay: s,
	currency,
	currencies,
	onClose,
	onSaved,
	onDelete
}: {
	base: string;
	stay: Stay;
	/** The trip's home currency, used when the stay carries none. */
	currency: string;
	currencies: string[];
	onClose: () => void;
	onSaved: () => void;
	onDelete: () => void | Promise<void>;
}) {
	const [name, setName] = useState(s.name);
	const [price, setPrice] = useState(s.price_cents == null ? '' : String(s.price_cents / 100));
	const [cur, setCur] = useState(s.currency || currency);
	const [url, setUrl] = useState(s.url ?? '');
	const [notes, setNotes] = useState(s.tag);
	const [checkIn, setCheckIn] = useState(s.check_in ?? '');
	const [checkOut, setCheckOut] = useState(s.check_out ?? '');

	// A stay that is booked on the calendar takes those bands with it, the same
	// way a place takes its events, so the question says so.
	const del = useDeleteAction({
		title:
			s.linked > 0
				? copy.discover.deleteStay.linkedTitle(s.name, s.linked)
				: copy.discover.deleteStay.title(s.name),
		busyLabel: copy.common.deleting,
		onDelete
	});

	const save = useMutation<[number | null]>(
		(cents) =>
			api(`${base}/stays/${s.id}`, {
				method: 'PATCH',
				body: {
					name: name.trim(),
					priceCents: cents,
					currency: cur,
					notes: notes.trim(),
					url: url.trim(),
					checkIn: checkIn || null,
					checkOut: checkOut || null
				}
			}),
		{ fallback: c.fallback, onSuccess: onSaved }
	);

	// Checked here as well as on the server so a typo costs no round trip, and
	// so the message names the field rather than the request.
	function submit(e: React.FormEvent) {
		e.preventDefault();
		const cents = parseMoneyToCents(price);
		if (cents === 'bad') return save.setError(c.badPrice);
		if (checkIn && checkOut && checkIn >= checkOut) return save.setError(c.badDates);
		void save.run(cents);
	}

	return (
		<>
			<Modal open={!del.asking} title={c.title} size="md" onClose={onClose}>
				<ModalForm onSubmit={submit}>
					<div className="mbody">
						<div className="flex flex-col gap-3">
							<Field
								label={c.nameLabel}
								autoFocus
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								inputClassName="w-full"
							/>
							<div className="grid grid-cols-2 gap-3">
								<Field
									label={c.priceLabel}
									optional
									type="number"
									min="0"
									step="1"
									value={price}
									onChange={(e) => setPrice(e.target.value)}
									inputClassName="w-full"
								/>
								<FieldShell label={c.currencyLabel}>
									<Select
										options={currencyOptions(currencies)}
										value={cur}
										onChange={setCur}
										ariaLabel={c.currencyLabel}
									/>
								</FieldShell>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<Field
									label={c.checkInLabel}
									optional
									type="date"
									value={checkIn}
									onChange={(e) => setCheckIn(e.target.value)}
									inputClassName="w-full"
								/>
								<Field
									label={c.checkOutLabel}
									optional
									type="date"
									value={checkOut}
									onChange={(e) => setCheckOut(e.target.value)}
									inputClassName="w-full"
								/>
							</div>
							<LinkField value={url} onChange={setUrl} />
							<NotesField value={notes} onChange={setNotes} />
						</div>
					</div>
					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={copy.common.saving}
						submitLabel={copy.common.save}
						start={del.button}
					/>
				</ModalForm>
			</Modal>
			{del.confirm}
		</>
	);
}
