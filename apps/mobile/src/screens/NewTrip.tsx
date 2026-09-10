import { useState } from 'react';
import { View } from 'react-native';
import { copy } from '@trippy/copy';
import { api } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { Sheet } from '../ui/Sheet';
import { space } from '../theme';

/**
 * Creating a trip.
 *
 * Dates are typed as YYYY-MM-DD rather than picked, because the server takes
 * day strings and a native date picker would hand back an instant in the
 * phone's zone, which is exactly the conversion this app spends its time
 * avoiding. A picker can come later once it is wired to produce a day string
 * directly.
 */
export function NewTrip({
	open,
	onClose,
	onCreated
}: {
	open: boolean;
	onClose: () => void;
	onCreated: (tripId: string) => void;
}) {
	const [name, setName] = useState('');
	const [startDate, setStart] = useState('');
	const [endDate, setEnd] = useState('');
	const [homeCurrency, setCurrency] = useState('USD');

	const submit = useMutation(
		async () => {
			const { trip } = await api<{ trip: { id: string } }>('/trips', {
				method: 'POST',
				body: { name, startDate, endDate, homeCurrency }
			});
			onCreated(trip.id);
		},
		{ fallback: copy.trips.newDialog.fallback }
	);

	return (
		<Sheet open={open} title={copy.trips.newDialog.title} onClose={onClose}>
			<Field label={copy.tripForm.nameLabel} value={name} onChangeText={setName} />
			<View style={{ flexDirection: 'row', gap: space.md }}>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.tripForm.startLabel}
						value={startDate}
						onChangeText={setStart}
						placeholder="2026-04-16"
						autoCapitalize="none"
					/>
				</View>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.tripForm.endLabel}
						value={endDate}
						onChangeText={setEnd}
						placeholder="2026-04-24"
						autoCapitalize="none"
					/>
				</View>
			</View>
			<Field
				label={copy.tripForm.currencyLabel}
				value={homeCurrency}
				onChangeText={(v) => setCurrency(v.toUpperCase())}
				autoCapitalize="characters"
				maxLength={3}
			/>
			<FormError message={submit.error} />
			<Button
				label={submit.busy ? copy.common.adding : copy.common.add}
				onPress={() => void submit.run()}
				busy={submit.busy}
			/>
		</Sheet>
	);
}
