import { useState } from 'react';
import { POI_KINDS, type PoiKind } from '@trippy/core/types';
import { api } from '../../api';
import { useMutation } from '../../useMutation';
import Modal from '../../components/Modal';
import FormError from '../../components/FormError';
import { Field } from '../../components/Field';
import type { Poi } from '../../api-types';
import { LinkField, NotesField, TypeField } from './place-fields';
import { VIEW_LABEL } from './views';

/**
 * Edit the traveller-authored half of a place.
 *
 * Provider-derived data (rating, hours, photo, coordinates) is deliberately not
 * editable: it belongs to the provider and is refreshed from it. The bucket is,
 * because it is a decision rather than provider data, and a misfiled place is
 * otherwise only fixable by deleting and re-adding it.
 *
 * Stays are not an option here. A stay is a row in another table with a price,
 * a night range and its own vote, so "make this a stay" is not an edit.
 */
export default function EditPlaceDialog({
	base,
	poi: p,
	onClose,
	onSaved
}: {
	base: string;
	poi: Poi;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(p.name);
	const [notes, setNotes] = useState(p.notes ?? '');
	const [url, setUrl] = useState(p.url ?? '');
	const [kind, setKind] = useState<PoiKind>(p.kind);

	const save = useMutation(
		() =>
			api(`${base}/pois/${p.id}`, {
				method: 'PATCH',
				body: { name: name.trim(), notes: notes.trim(), url: url.trim(), kind }
			}),
		{ fallback: 'Could not save that place.', onSuccess: onSaved }
	);

	return (
		<Modal open title="Edit place" size="md" onClose={onClose}>
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody">
					<div className="flex flex-col gap-3">
						<Field
							label="Name"
							autoFocus
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							inputClassName="w-full"
						/>
						<TypeField
							options={POI_KINDS.map((k) => ({ value: k, label: VIEW_LABEL[k] }))}
							value={kind}
							onChange={(v) => setKind(v as PoiKind)}
						/>
						<NotesField value={notes} onChange={setNotes} />
						<LinkField value={url} onChange={setUrl} />
					</div>
					{/* Read-only, so it sits after the fields: the count answers "is this
					    popular?", which the card already told you. The names answer
					    "whose evening am I cancelling?", which is why you opened this. */}
					<p className="mt-3.5 border-t border-line pt-3.5 text-[0.85rem] leading-normal">
						<span className="font-semibold">{p.votes === 1 ? '1 vote' : `${p.votes} votes`}</span>
						<span className="muted">
							{p.voters.length ? `: ${p.voters.join(', ')}` : ', nobody yet'}
						</span>
					</p>
				</div>
				<div className="mfoot">
					<FormError message={save.error} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={save.busy}>
						{save.busy ? 'Saving...' : 'Save'}
					</button>
				</div>
			</form>
		</Modal>
	);
}
