import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Stack, Tabs, router, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { NativeTabsContext } from '../../../src/ui/nativeTabs';
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
import {
	Button,
	DestructiveRow,
	Field,
	FormError,
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { ConfirmSheet, confirmOverlays } from '../../../src/ui/ConfirmSheet';
import { Sheet } from '../../../src/ui/Sheet';
import { DateField, SearchablePicker } from '../../../src/ui/controls';
import { useToast } from '../../../src/ui/Toast';
import { AppSymbol, type AppSymbolName } from '../../../src/ui/Symbol';
import {
	TripHeaderActionProvider,
	useCurrentTripHeaderAction
} from '../../../src/ui/TripHeaderAction';
import { useSheetHandoff } from '../../../src/ui/useSheetHandoff';
import { showActionMenu } from '../../../src/ui/actionMenu';
import { color, screenMargin, space, type } from '../../../src/theme';

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
type TabIcon = { sf: AppSymbolName; ion: ComponentProps<typeof AppSymbol>['fallback'] };
const TAB_ICONS: Record<string, TabIcon> = {
	discover: { sf: 'magnifyingglass', ion: 'search-outline' },
	pretrip: { sf: 'checklist', ion: 'checkbox-outline' },
	calendar: { sf: 'calendar', ion: 'calendar-outline' },
	expenses: { sf: 'creditcard', ion: 'card-outline' },
	people: { sf: 'person.2', ion: 'people-outline' }
};
const TAB_ORDER = ['discover', 'pretrip', 'calendar', 'expenses', 'people'] as const;
const TAB_LABELS: Record<(typeof TAB_ORDER)[number], () => string> = {
	discover: () => copy.nav.discover,
	pretrip: () => copy.nav.preparation,
	calendar: () => copy.nav.schedule,
	expenses: () => copy.nav.expenses,
	people: () => copy.nav.people
};
type TabScreenOptions = NonNullable<ComponentProps<typeof Tabs.Screen>['options']>;
type TabBarIconProps = Parameters<
	NonNullable<Extract<TabScreenOptions, { tabBarIcon?: unknown }>['tabBarIcon']>
>[0];
function tabIcon(icon: TabIcon) {
	return ({ color: tint, size }: TabBarIconProps) => (
		<AppSymbol name={icon.sf} fallback={icon.ion} size={size} color={tint} />
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
	const [actionsOpen, setActionsOpen] = useState(false);
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

	const actionHandoff = useSheetHandoff({
		edit: () => setEditing(true),
		leave: () => setConfirming('leave'),
		delete: () => setConfirming('delete')
	});
	const queueAction = (action: 'edit' | 'leave' | 'delete') =>
		actionHandoff.queue(action, () => setActionsOpen(false));
	const destroy = useMutation(
		async () => {
			if (!trip || !confirming) return;
			if (confirming === 'leave') await api(`/trips/${trip.id}/leave`, { method: 'POST' });
			else await api(`/trips/${trip.id}`, { method: 'DELETE' });
		},
		{ fallback: copy.ui.confirmDialog.fallback, onSuccess: () => router.replace('/trips') }
	);
	if (loading && !trip) return <Loading />;
	if (!trip)
		return (
			<Screen>
				<FormError message={error ?? copy.tripShell.notFound} />
				<Button label={copy.common.allTrips} onPress={() => router.replace('/trips')} />
			</Screen>
		);
	const canEdit = trip.role === 'organizer';
	return (
		<TripHeaderActionProvider>
			<TripTabsInner
				id={id}
				trip={trip}
				events={events}
				canEdit={canEdit}
				editing={editing}
				setEditing={setEditing}
				confirming={confirming}
				setConfirming={setConfirming}
				actionsOpen={actionsOpen}
				setActionsOpen={setActionsOpen}
				queueAction={queueAction}
				flushPendingAction={actionHandoff.flush}
				destroy={destroy}
				reload={reload}
			/>
		</TripHeaderActionProvider>
	);
}

function TripTabsInner({
	id,
	trip,
	events,
	canEdit,
	editing,
	setEditing,
	confirming,
	setConfirming,
	actionsOpen,
	setActionsOpen,
	queueAction,
	flushPendingAction,
	destroy,
	reload
}: {
	id: string;
	trip: Trip;
	events: ReturnType<typeof useTripEvents>;
	canEdit: boolean;
	editing: boolean;
	setEditing: (value: boolean) => void;
	confirming: 'delete' | 'leave' | null;
	setConfirming: (value: 'delete' | 'leave' | null) => void;
	actionsOpen: boolean;
	setActionsOpen: (value: boolean) => void;
	queueAction: (action: 'edit' | 'leave' | 'delete') => void;
	flushPendingAction: () => void;
	destroy: ReturnType<typeof useMutation>;
	reload: () => void;
}) {
	const headerAdd = useCurrentTripHeaderAction();
	const pathname = usePathname();
	const bareTripPath = Platform.OS === 'ios' && /^\/trip\/[^/]+\/?$/.test(pathname);
	const stack = useNavigation();
	useEffect(() => {
		// A router.replace would be resolved against the trip's half-built
		// state and target a 'discover' screen the root stack does not have, so
		// the root stack is told directly to replace the trip with its tab.
		if (bareTripPath)
			stack.dispatch({
				type: 'REPLACE',
				payload: { name: 'trip/[tripId]', params: { tripId: id, screen: 'discover' } }
			});
	}, [bareTripPath, id, stack]);
	// On a cold-start link the trip is the only screen, so there is no back
	// button to Your trips; the account menu stays as the way out. Asked of the
	// root stack: the router's own answer comes from the tabs, which can always
	// go back to Discover.
	const canGoBack = stack.canGoBack();
	const renderActions = () => (
		<View
			style={{
				flexDirection: 'row',
				alignItems: 'center',
				gap: space.lg
			}}
		>
			{headerAdd ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={copy.common.add}
					onPress={headerAdd}
					hitSlop={8}
				>
					<AppSymbol name="plus" fallback="add" size={24} color={color.accent} />
				</Pressable>
			) : null}
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={copy.common.more}
				onPress={() => {
					if (destroy.busy) return;
					const shown = showActionMenu(
						trip.name,
						canEdit
							? [
									{ label: copy.tripShell.editTrip, onPress: () => setEditing(true) },
									{
										label: copy.common.delete,
										destructive: true,
										onPress: () => setConfirming('delete')
									}
								]
							: [
									{
										label: copy.tripShell.leaveTrip,
										destructive: true,
										onPress: () => setConfirming('leave')
									}
								]
					);
					if (!shown) setActionsOpen(true);
				}}
				hitSlop={8}
			>
				<AppSymbol
					name="ellipsis.circle"
					fallback="ellipsis-horizontal-circle-outline"
					size={24}
					color={color.accent}
				/>
			</Pressable>
			{/* On iOS the trip has a back button to Your trips, where the account
			    menu lives; dropping it here leaves the centred system title room
			    for most trip names. */}
			{Platform.OS === 'ios' && canGoBack ? null : <AccountMenu />}
		</View>
	);
	const tabs =
		Platform.OS === 'ios' ? (
			<>
				{/* On iOS the trip gets the stack's own navigation bar, with a back
				    button to Your trips, and the system tab bar under Liquid Glass.
				    Native tabs draw no header of their own, so the bar is the parent
				    stack's, configured from here. */}
				<Stack.Screen options={{ title: trip.name, headerRight: renderActions }} />
				{bareTripPath ? (
					// The trip itself, with no tab: native tabs cannot show the hidden
					// index route (the dev build throws trying). System links are
					// rewritten in app/+native-intent.tsx; anything else waits here for
					// the replace below.
					<View style={{ flex: 1, backgroundColor: color.bg }} />
				) : (
					<NativeTabsContext.Provider value>
						<NativeTabs tintColor={color.accent} minimizeBehavior="onScrollDown">
							{TAB_ORDER.map((name) => (
								<NativeTabs.Trigger
									key={name}
									name={name}
									contentStyle={{ backgroundColor: color.bg }}
								>
									<NativeTabs.Trigger.Label>{TAB_LABELS[name]()}</NativeTabs.Trigger.Label>
									<NativeTabs.Trigger.Icon sf={TAB_ICONS[name].sf as never} />
								</NativeTabs.Trigger>
							))}
							<NativeTabs.Trigger name="index" hidden />
						</NativeTabs>
					</NativeTabsContext.Provider>
				)}
			</>
		) : null;
	return (
		<TripIdContext.Provider value={id}>
			<TripEventsProvider value={events}>
				<View style={{ flex: 1 }}>
					{tabs ?? (
						<Tabs
							screenOptions={{
								headerStyle: { backgroundColor: color.bg },
								headerShadowVisible: false,
								headerTintColor: color.accent,
								headerTitleStyle: type.head,
								headerTitle: trip.name,
								// Three header buttons leave a centred title about a third of
								// the bar, which cut most trip names off. Leading-aligned, the
								// name gets everything the buttons do not use, as on web.
								headerTitleAlign: 'left',
								// The title may shrink, and the buttons keep their natural
								// width. The header's own flex rules do the reverse (the right
								// side takes only what the title leaves), which let a long name
								// run under the three buttons.
								headerTitleContainerStyle: { flexGrow: 1, flexShrink: 1 },
								headerRightContainerStyle: {
									paddingRight: screenMargin,
									flexGrow: 0,
									flexBasis: 'auto'
								},
								headerRight: renderActions,
								tabBarActiveTintColor: color.accent,
								tabBarInactiveTintColor: color.inkFaint,
								tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.line },
								tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
								sceneStyle: { backgroundColor: color.bg }
							}}
						>
							<Tabs.Screen
								name="discover"
								options={{ title: copy.nav.discover, tabBarIcon: tabIcon(TAB_ICONS.discover) }}
							/>
							<Tabs.Screen
								name="pretrip"
								options={{ title: copy.nav.preparation, tabBarIcon: tabIcon(TAB_ICONS.pretrip) }}
							/>
							<Tabs.Screen
								name="calendar"
								options={{ title: copy.nav.schedule, tabBarIcon: tabIcon(TAB_ICONS.calendar) }}
							/>
							<Tabs.Screen
								name="expenses"
								options={{ title: copy.nav.expenses, tabBarIcon: tabIcon(TAB_ICONS.expenses) }}
							/>
							<Tabs.Screen
								name="people"
								options={{ title: copy.nav.people, tabBarIcon: tabIcon(TAB_ICONS.people) }}
							/>
							<Tabs.Screen name="index" options={{ href: null }} />
						</Tabs>
					)}
				</View>
				<TripActionSheet
					open={actionsOpen}
					trip={trip}
					canEdit={canEdit}
					onClose={() => setActionsOpen(false)}
					onEdit={() => queueAction('edit')}
					onLeave={() => queueAction('leave')}
					onDelete={() => queueAction('delete')}
					onDismiss={flushPendingAction}
				/>
				<EditTripSheet
					trip={trip}
					open={editing}
					busy={confirmOverlays && destroy.busy}
					onClose={() => setEditing(false)}
					onSaved={() => {
						setEditing(false);
						reload();
					}}
					onDelete={() => {
						if (!confirmOverlays) setEditing(false);
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
					error={destroy.error}
					onCancel={() => setConfirming(null)}
					onConfirm={() => void destroy.run()}
				/>
			</TripEventsProvider>
		</TripIdContext.Provider>
	);
}

function TripActionSheet({
	open,
	trip,
	canEdit,
	onClose,
	onEdit,
	onLeave,
	onDelete,
	onDismiss
}: {
	open: boolean;
	trip: Trip;
	canEdit: boolean;
	onClose: () => void;
	onEdit: () => void;
	onLeave: () => void;
	onDelete: () => void;
	onDismiss: () => void;
}) {
	return (
		<Sheet open={open} title={trip.name} onClose={onClose} onDismiss={onDismiss}>
			<InsetSection>
				{canEdit ? (
					<>
						<ListRow
							title={copy.tripShell.editTrip}
							symbol={{ name: 'pencil', fallback: 'create-outline' }}
							onPress={onEdit}
						/>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(trip.name)}
							onPress={onDelete}
						/>
					</>
				) : (
					<DestructiveRow title={copy.tripShell.leaveTrip} onPress={onLeave} />
				)}
			</InsetSection>
		</Sheet>
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
	busy,
	onClose,
	onSaved,
	onDelete
}: {
	trip: Trip;
	open: boolean;
	busy: boolean;
	onClose: () => void;
	onSaved: () => void;
	onDelete: () => void;
}) {
	const [name, setName] = useState(trip.name);
	const [startDate, setStartDate] = useState(trip.start_date ?? '');
	const [endDate, setEndDate] = useState(trip.end_date ?? '');
	const [currency, setCurrency] = useState(trip.home_currency);
	const [locked, setLocked] = useState(trip.schedule_locked === 1);
	const [initialSpan, setInitialSpan] = useState(
		spanDays(trip.start_date ?? '', trip.end_date ?? '') ?? 0
	);
	const wasOpen = useRef(false);
	const options = useMemo(
		() => CURRENCY_CODES.map((code) => ({ key: code, label: code, detail: currencyName(code) })),
		[]
	);
	useEffect(() => {
		if (!open) {
			wasOpen.current = false;
			return;
		}
		if (wasOpen.current) return;
		wasOpen.current = true;
		setName(trip.name);
		setStartDate(trip.start_date ?? '');
		setEndDate(trip.end_date ?? '');
		setCurrency(trip.home_currency);
		setLocked(trip.schedule_locked === 1);
		setInitialSpan(spanDays(trip.start_date ?? '', trip.end_date ?? '') ?? 0);
	}, [open, trip]);
	const save = useMutation(
		async () => {
			const span = spanDays(startDate, endDate);
			if (span !== null && span > MAX_DAYS && span > initialSpan)
				throw new Error(copy.tripForm.tooLong);
			await api(`/trips/${trip.id}`, {
				method: 'PATCH',
				body: { name, startDate, endDate, currency, scheduleLocked: locked }
			});
		},
		{ fallback: copy.tripShell.editDialog.fallback, onSuccess: onSaved }
	);
	return (
		<Sheet
			open={open}
			title={copy.tripShell.editDialog.title}
			onClose={onClose}
			onPrimary={() => void save.run()}
			primaryLabel={copy.common.save}
			primaryBusyLabel={copy.common.saving}
			primaryBusy={save.busy}
			busy={busy}
			busyLabel={copy.common.deleting}
		>
			<InsetSection footer={copy.tripShell.editDialog.lockFooter} error={save.error}>
				<Field variant="row" label={copy.tripForm.nameLabel} value={name} onChangeText={setName} />
				<DateField
					label={copy.tripForm.startLabel}
					value={startDate}
					onChange={setStartDate}
					maximum={endDate || undefined}
				/>
				<DateField
					label={copy.tripForm.endLabel}
					value={endDate}
					onChange={setEndDate}
					minimum={startDate || undefined}
				/>
				<SearchablePicker
					variant="row"
					label={copy.tripForm.currencyLabel}
					value={currency}
					options={options}
					onPick={setCurrency}
					noMatches={copy.ui.currencyPicker.noMatches}
				/>
				<ListRow
					title={copy.tripShell.editDialog.lockLabel}
					symbol={{ name: 'lock', fallback: 'lock-closed-outline' }}
					accessory="switch"
					switchValue={locked}
					onSwitch={setLocked}
					last
				/>
			</InsetSection>
			<InsetSection>
				<DestructiveRow
					title={copy.common.delete}
					accessibilityLabel={copy.common.deleteLabel(trip.name)}
					onPress={onDelete}
				/>
			</InsetSection>
		</Sheet>
	);
}
