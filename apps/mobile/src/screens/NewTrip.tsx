import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { copy } from '@trippy/copy';
import { nightsBetween } from '@trippy/copy/format';
import { CURRENCY_CODES } from '@trippy/core/currency';
import { currencyName } from '@trippy/core/currency-names';
import { api } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { DateField, SearchablePicker } from '../ui/controls';
import { Field, FormError, InsetSection } from '../ui';
import { Sheet } from '../ui/Sheet';
import { space } from '../theme';

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
		<Sheet
			open={open}
			title={copy.trips.newDialog.title}
			onClose={onClose}
			onPrimary={() => void submit.run()}
			primaryLabel={copy.common.add}
			primaryBusyLabel={copy.common.adding}
			primaryBusy={submit.busy}
		>
			<InsetSection>
				<View style={{ gap: space.md, padding: space.md }}>
					<Field label={copy.tripForm.nameLabel} value={name} onChangeText={setName} />
					<View style={{ flexDirection: 'row', gap: space.md }}>
						<View style={{ flex: 1 }}>
							<DateField
								label={copy.tripForm.startLabel}
								value={startDate}
								onChange={setStart}
								maximum={endDate || undefined}
							/>
						</View>
						<View style={{ flex: 1 }}>
							<DateField
								label={copy.tripForm.endLabel}
								value={endDate}
								onChange={setEnd}
								minimum={startDate || undefined}
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
				</View>
			</InsetSection>
			<FormError message={submit.error} />
		</Sheet>
	);
}

function spanDays(start: string, end: string): number | null {
	if (!start || !end) return null;
	if (start === end) return 1;
	const nights = nightsBetween(start, end);
	return nights === null ? null : nights + 1;
}
