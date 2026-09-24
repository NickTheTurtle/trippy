let busyCount = 0;
const listeners = new Set<() => void>();

export function setInteractionBusy(busy: boolean): () => void {
	if (busy) busyCount += 1;
	else busyCount = Math.max(0, busyCount - 1);
	for (const listener of listeners) listener();
	return () => {
		if (!busy) return;
		busyCount = Math.max(0, busyCount - 1);
		for (const listener of listeners) listener();
	};
}

export function isInteractionBusy(): boolean {
	return busyCount > 0;
}

export function onInteractionBusyChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
