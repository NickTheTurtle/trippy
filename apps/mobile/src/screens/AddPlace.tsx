import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { parseMoneyToCents } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import type { PlaceHit } from '../lib/api-types';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { Sheet } from '../ui/Sheet';
import { color, radius, space, type } from '../theme';

/**
 * Adding a place or a stay to a city.
 *
 * The search half is deliberately the same shape as the web dialog: type a
 * name, pick a provider result, and the fields that result carries are sent
 * with it so the card has a rating and a photo without a second lookup. Picking
 * is optional; a name typed by hand still adds.
 *
 * The search is debounced because every keystroke past the minimum would
 * otherwise be a paid provider call.
 */
const MIN_QUERY = 3;

export function AddPlace({
	open,
	tripId,
	city,
	stay,
	onClose,
	onAdded
}: {
	open: boolean;
	tripId: string;
	city: { id: string; name: string };
	stay: boolean;
	onClose: () => void;
	onAdded: () => void;
}) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<PlaceHit[]>([]);
	const [picked, setPicked] = useState<PlaceHit | null>(null);
	const [searching, setSearching] = useState(false);
	const [price, setPrice] = useState('');
	const [notes, setNotes] = useState('');

	useEffect(() => {
		if (!open) {
			setQuery('');
			setHits([]);
			setPicked(null);
			setPrice('');
			setNotes('');
		}
	}, [open]);

	useEffect(() => {
		if (picked || query.trim().length < MIN_QUERY) {
			setHits([]);
			return;
		}
		const ac = new AbortController();
		setSearching(true);
		const timer = setTimeout(() => {
			api<{ results: PlaceHit[] }>(
				`/trips/${tripId}/discover/search?q=${encodeURIComponent(query.trim())}&cityId=${city.id}&kind=${stay ? 'stay' : 'place'}`,
				{ signal: ac.signal }
			)
				.then((r) => setHits(r.results))
				.catch(() => setHits([]))
				.finally(() => setSearching(false));
		}, 350);
		return () => {
			clearTimeout(timer);
			ac.abort();
		};
	}, [query, picked, tripId, city.id, stay]);

	const submit = useMutation(
		async () => {
			const name = picked?.name ?? query.trim();
			if (!name) throw new ApiError(400, copy.discover.addDialog.fallback);

			if (stay) {
				const cents = parseMoneyToCents(price);
				// Thrown as an ApiError so it lands in the same place a server refusal
				// would, rather than being replaced by the generic fallback.
				if (cents === 'bad') throw new ApiError(400, copy.discover.addDialog.badPrice);
				await api(`/trips/${tripId}/discover/stays`, {
					method: 'POST',
					body: {
						cityId: city.id,
						name,
						notes,
						url: picked?.url ?? null,
						priceCents: cents,
						photo: picked?.photo ?? null
					}
				});
			} else {
				await api(`/trips/${tripId}/discover/pois`, {
					method: 'POST',
					body: {
						cityId: city.id,
						name,
						category: picked?.category ?? '',
						notes,
						url: picked?.url ?? null,
						lat: picked?.lat ?? null,
						lng: picked?.lng ?? null,
						rating: picked?.rating ?? null,
						ratingCount: picked?.ratingCount ?? null,
						priceLevel: picked?.priceLevel ?? null,
						hours: picked?.hours ?? null,
						photo: picked?.photo ?? null
					}
				});
			}
			onAdded();
		},
		{ fallback: copy.discover.addDialog.fallback }
	);

	return (
		<Sheet open={open} title={copy.discover.addDialog.title} subtitle={city.name} onClose={onClose}>
			{picked ? (
				<View style={{ gap: space.xs }}>
					<Text style={type.body}>{picked.name}</Text>
					{picked.address ? <Text style={type.faint}>{picked.address}</Text> : null}
					<Pressable onPress={() => setPicked(null)} hitSlop={8}>
						<Text style={{ ...type.small, color: color.accent }}>
							{copy.discover.addDialog.notThisOne}
						</Text>
					</Pressable>
				</View>
			) : (
				<>
					<Field
						label={copy.discover.addDialog.nameLabel}
						value={query}
						onChangeText={setQuery}
						autoCorrect={false}
					/>
					{query.trim().length < MIN_QUERY ? (
						<Text style={type.faint}>{copy.discover.addDialog.keepTyping}</Text>
					) : searching ? (
						<Text style={type.faint}>{copy.discover.addDialog.searching}</Text>
					) : hits.length === 0 ? (
						<Text style={type.faint}>{copy.discover.addDialog.noMatches(query.trim())}</Text>
					) : (
						<View style={{ borderWidth: 1, borderColor: color.line, borderRadius: radius.md }}>
							{hits.slice(0, 6).map((h, i) => (
								<Pressable
									key={`${h.id ?? h.name}-${i}`}
									onPress={() => setPicked(h)}
									style={({ pressed }) => ({
										paddingHorizontal: space.md,
										paddingVertical: space.sm,
										backgroundColor: pressed ? color.surface2 : color.surface,
										borderTopWidth: i === 0 ? 0 : 1,
										borderTopColor: color.line
									})}
								>
									<Text style={type.body}>{h.name}</Text>
									{h.address ? <Text style={type.faint}>{h.address}</Text> : null}
								</Pressable>
							))}
						</View>
					)}
				</>
			)}

			{stay ? (
				<Field
					label={copy.discover.addDialog.priceLabel}
					value={price}
					onChangeText={setPrice}
					keyboardType="decimal-pad"
				/>
			) : null}

			<Field label={copy.discover.placeFields.notesLabel} value={notes} onChangeText={setNotes} />

			<FormError message={submit.error} />
			<Button
				label={submit.busy ? copy.common.adding : copy.common.add}
				onPress={() => void submit.run()}
				busy={submit.busy}
				disabled={!picked && query.trim().length === 0}
			/>
		</Sheet>
	);
}
