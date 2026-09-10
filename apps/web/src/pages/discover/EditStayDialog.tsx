import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import { Field } from '../../components/ui/Field';
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
 * Currency is absent for the same reason the add popup omits it: a price typed
 * on this page is in the trip's home currency.
 */
export default function EditStayDialog({
	base,
	stay: s,
	onClose,
	onSaved
}: {
	base: string;
	stay: Stay;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(s.name);
	const [price, setPrice] = useState(s.price_cents == null ? '' : String(s.price_cents / 100));
	const [url, setUrl] = useState(s.url ?? '');
	const [notes, setNotes] = useState(s.tag);
	const [checkIn, setCheckIn] = useState(s.check_in ?? '');
	const [checkOut, setCheckOut] = useState(s.check_out ?? '');

	const save = useMutation<[number | null]>(
		(cents) =>
			api(`${base}/stays/${s.id}`, {
				method: 'PATCH',
				body: {
					name: name.trim(),
					priceCents: cents,
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
		if (checkIn && checkOut && checkIn > checkOut) return save.setError(c.badDates);
		void save.run(cents);
	}

	return (
		<Modal open title={c.title} size="md" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
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
				/>
			</form>
		</Modal>
	);
}
