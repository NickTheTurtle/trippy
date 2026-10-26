import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { localDay, openingScheduleDay } from '@trippy/core/schedule-day';

const key = (tripId: string) => `trippy.schedule.day.${tripId}`;
const web = Platform.OS === 'web';

export async function scheduleOpeningDay(trip: {
	id: string;
	start_date: string | null;
	end_date: string | null;
}): Promise<string | null> {
	const remembered = web
		? (globalThis.localStorage?.getItem(key(trip.id)) ?? null)
		: await SecureStore.getItemAsync(key(trip.id)).catch(() => null);
	return openingScheduleDay({
		remembered,
		today: localDay(),
		start: trip.start_date,
		end: trip.end_date
	});
}

export async function rememberScheduleDay(tripId: string, day: string): Promise<void> {
	if (web) {
		try {
			globalThis.localStorage?.setItem(key(tripId), day);
		} catch {
			// Remembering is a convenience, not part of the schedule's state.
		}
		return;
	}
	await SecureStore.setItemAsync(key(tripId), day).catch(() => {});
}
