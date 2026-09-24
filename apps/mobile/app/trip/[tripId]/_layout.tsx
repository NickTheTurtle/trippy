import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Tabs, router, useLocalSearchParams } from 'expo-router';
import type { ColorValue } from 'react-native';
import type { ComponentProps } from 'react';
import { copy } from '@trippy/copy';
import { nightsBetween } from '@trippy/copy/format';
import { CURRENCY_CODES } from '@trippy/core/currency';
import { currencyName } from '@trippy/core/currency-names';
import { AccountMenu } from '../../../src/ui/AccountMenu';
import { TripIdContext } from '../../../src/trip-id';
import { api } from '../../../src/lib/api';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { TripEventsProvider, useTripEvents } from '../../../src/hooks/useTripEvents';
import { Button, Field, FormError, Loading, Screen } from '../../../src/ui';
import { ConfirmSheet } from '../../../src/ui/ConfirmSheet';
import { Sheet } from '../../../src/ui/Sheet';
import { CheckBox, SearchablePicker } from '../../../src/ui/controls';
import { useToast } from '../../../src/ui/Toast';
import { color, font, space, type } from '../../../src/theme';

type Trip = {
	id: string;
	name: string;
	dates: string;
	home_currency: string;
	start_date: string | null;
	end_date: string | null;
	role: string;
	schedule_locked: number;
	members: string[];
};

const ICON = {
	discover: '◍',
	pretrip: '✓',
	calendar: '▤',
	expenses: '$',
	people: '☺'
} as const;

type TabScreenOptions = NonNullable<ComponentProps<typeof Tabs.Screen>['options']>;
type TabBarIconProps = Parameters<
	NonNullable<Extract<TabScreenOptions, { tabBarIcon?: unknown }>['tabBarIcon']>
>[0];

function icon(glyph: string) {
	return ({ color: tint, size }: TabBarIconProps) => (
		<Text style={{ color: tint as ColorValue, fontSize: size - 2 }}>{glyph}</Text>
	);
}

export default function TripTabs() {
	const { tripId } = useLocalSearchParams<{ tripId: string }>();
	const id = tripId ?? '';
	const toast = useToast();
	const { data, error, errorStatus, loading, reload } = useApi<{ trip: Trip }>(
		id ? `/trips/${id}` : null
	);
	const events = useTripEvents(id || null);
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState<'delete' | 'leave' | null>(null);
	const loadedFor = useRef<string | null>(null);

	const trip = data?.trip.id === id ? data.trip : null;
	if (trip) loadedFor.current = trip.id;

	useEffect(
		() => events.control.subscribe(['trip', 'members', 'schedule'], reload),
		[events.control, reload]
	);

	useEffect(() => {
		const gone = errorStatus === 403 || errorStatus === 404;
		if (!gone || loadedFor.current !== id) return;
		loadedFor.current = null;
		toast.error(copy.tripShell.gone);
		router.replace('/trips');
	}, [errorStatus, id, toast]);

	const destroy = useMutation(
		async () => {
			if (!trip || !confirming) return;
			if (confirming === 'leave') await api(`/trips/${trip.id}/leave`, { method: 'POST' });
			else await api(`/trips/${trip.id}`, { method: 'DELETE' });
		},
		{ fallback: copy.ui.confirmDialog.fallback, onSuccess: () => router.replace('/trips') }
	);

	if (loading && !trip) return <Loading />;
	if (!trip) {
		return (
			<Screen>
				<FormError message={error ?? copy.tripShell.notFound} />
				<Button label={copy.common.allTrips} onPress={() => router.replace('/trips')} />
			</Screen>
		);
	}

	const canEdit = trip.role === 'organizer';
	return (
		<TripIdContext.Provider value={id}>
			<TripEventsProvider value={events}>
				<Tabs
					screenOptions={{
						headerStyle: { backgroundColor: color.bg },
						headerShadowVisible: false,
						headerTintColor: color.ink,
						headerTitle: trip.name,
						headerTitleStyle: { ...font.heading, fontSize: 17 },
						headerRight: () => (
							<View
								style={{
									flexDirection: 'row',
									alignItems: 'center',
									gap: space.sm,
									marginRight: space.sm
								}}
							>
								<Pressable
									onPress={() => (canEdit ? setEditing(true) : setConfirming('leave'))}
									hitSlop={8}
								>
									<Text style={{ ...type.small, color: color.accent, fontWeight: '600' }}>
										{canEdit ? copy.tripShell.editTrip : copy.tripShell.leaveTrip}
									</Text>
								</Pressable>
								<AccountMenu />
							</View>
						),
						tabBarActiveTintColor: color.accent,
						tabBarInactiveTintColor: color.inkFaint,
						tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.line },
						tabBarLabelStyle: { fontSize: 11 },
						sceneStyle: { backgroundColor: color.bg }
					}}
				>
					<Tabs.Screen
						name="discover"
						options={{ title: copy.nav.discover, tabBarIcon: icon(ICON.discover) }}
					/>
					<Tabs.Screen
						name="pretrip"
						options={{ title: copy.nav.preparation, tabBarIcon: icon(ICON.pretrip) }}
					/>
					<Tabs.Screen
						name="calendar"
						options={{ title: copy.nav.schedule, tabBarIcon: icon(ICON.calendar) }}
					/>
					<Tabs.Screen
						name="expenses"
						options={{ title: copy.nav.expenses, tabBarIcon: icon(ICON.expenses) }}
					/>
					<Tabs.Screen
						name="people"
						options={{ title: copy.nav.people, tabBarIcon: icon(ICON.people) }}
					/>
					<Tabs.Screen name="index" options={{ href: null }} />
				</Tabs>
				<EditTripSheet
					trip={trip}
					open={editing}
					onClose={() => setEditing(false)}
					onSaved={() => {
						setEditing(false);
						reload();
					}}
					onDelete={() => {
						setEditing(false);
						setConfirming('delete');
					}}
				/>
				<ConfirmSheet
					open={confirming !== null}
					title={
						confirming === 'leave'
							? copy.tripShell.leaveDialog.title(trip.name)
							: copy.common.deleteTitle(trip.name)
					}
					confirmLabel={confirming === 'leave' ? copy.common.leave : copy.common.delete}
					busyLabel={confirming === 'leave' ? copy.common.working : copy.common.deleting}
					busy={destroy.busy}
					onCancel={() => setConfirming(null)}
					onConfirm={() => void destroy.run()}
				/>
			</TripEventsProvider>
		</TripIdContext.Provider>
	);
}

const MAX_DAYS = 366;

function spanDays(start: string, end: string): number | null {
	if (!start || !end) return null;
	if (start === end) return 1;
	const nights = nightsBetween(start, end);
	return nights === null ? null : nights + 1;
}

function EditTripSheet({
	trip,
	open,
	onClose,
	onSaved,
	onDelete
}: {
	trip: Trip;
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
	onDelete: () => void;
}) {
	const [name, setName] = useState(trip.name);
	const [startDate, setStartDate] = useState(trip.start_date ?? '');
	const [endDate, setEndDate] = useState(trip.end_date ?? '');
	const [currency, setCurrency] = useState(trip.home_currency);
	const [locked, setLocked] = useState(trip.schedule_locked === 1);
	const wasSpan = spanDays(trip.start_date ?? '', trip.end_date ?? '') ?? 0;
	const options = useMemo(
		() => CURRENCY_CODES.map((code) => ({ key: code, label: code, detail: currencyName(code) })),
		[]
	);

	useEffect(() => {
		if (!open) return;
		setName(trip.name);
		setStartDate(trip.start_date ?? '');
		setEndDate(trip.end_date ?? '');
		setCurrency(trip.home_currency);
		setLocked(trip.schedule_locked === 1);
	}, [open, trip]);

	const save = useMutation(
		async () => {
			const span = spanDays(startDate, endDate);
			if (span !== null && span > MAX_DAYS && span > wasSpan)
				throw new Error(copy.tripForm.tooLong);
			await api(`/trips/${trip.id}`, {
				method: 'PATCH',
				body: { name, startDate, endDate, currency, scheduleLocked: locked }
			});
		},
		{ fallback: copy.tripShell.editDialog.fallback, onSuccess: onSaved }
	);

	return (
		<Sheet open={open} title={copy.tripShell.editDialog.title} onClose={onClose}>
			<Field label={copy.tripForm.nameLabel} value={name} onChangeText={setName} />
			<View style={{ flexDirection: 'row', gap: space.md }}>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.tripForm.startLabel}
						value={startDate}
						onChangeText={setStartDate}
						placeholder="2026-04-16"
						autoCapitalize="none"
					/>
				</View>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.tripForm.endLabel}
						value={endDate}
						onChangeText={setEndDate}
						placeholder="2026-04-24"
						autoCapitalize="none"
					/>
				</View>
			</View>
			<SearchablePicker
				label={copy.tripForm.currencyLabel}
				value={currency}
				options={options}
				onPick={setCurrency}
				noMatches={copy.ui.currencyPicker.noMatches}
			/>
			<Pressable
				onPress={() => setLocked((v) => !v)}
				style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
			>
				<CheckBox
					checked={locked}
					label={copy.tripShell.editDialog.lockLabel}
					onPress={() => setLocked((v) => !v)}
				/>
				<Text style={type.body}>{copy.tripShell.editDialog.lockLabel}</Text>
			</Pressable>
			<FormError message={save.error} />
			<View style={{ flexDirection: 'row', gap: space.md }}>
				<View style={{ flex: 1 }}>
					<Button label={copy.common.delete} tone="danger" onPress={onDelete} />
				</View>
				<View style={{ flex: 1 }}>
					<Button
						label={save.busy ? copy.common.saving : copy.common.save}
						onPress={() => void save.run()}
						busy={save.busy}
					/>
				</View>
			</View>
		</Sheet>
	);
}
