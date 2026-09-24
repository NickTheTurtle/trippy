import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { copy } from '@trippy/copy';
import { nightsBetween } from '@trippy/copy/format';
import { CURRENCY_CODES } from '@trippy/core/currency';
import { currencyName } from '@trippy/core/currency-names';
import { api } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { SearchablePicker } from '../ui/controls';
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
	const currencyOptions = useMemo(
		() => CURRENCY_CODES.map((code) => ({ key: code, label: code, detail: currencyName(code) })),
		[]
	);

	const submit = useMutation(
		async () => {
			const span = spanDays(startDate, endDate);
			if (span !== null && span > 366) throw new Error(copy.tripForm.tooLong);
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
			<SearchablePicker
				label={copy.tripForm.currencyLabel}
				value={homeCurrency}
				options={currencyOptions}
				onPick={setCurrency}
				noMatches={copy.ui.currencyPicker.noMatches}
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

function spanDays(start: string, end: string): number | null {
	if (!start || !end) return null;
	if (start === end) return 1;
	const nights = nightsBetween(start, end);
	return nights === null ? null : nights + 1;
}
