declare const TextDecoder: {
	new (): { decode(input?: Uint8Array, options?: { stream?: boolean }): string };
};

export type SseMessage = { event: string; data: string; id: string | null };

export type SseParser = {
	push: (chunk: Uint8Array) => void;
	end: () => void;
};

export function createSseParser({
	onMessage,
	onId
}: {
	onMessage: (message: SseMessage) => void;
	onId?: (id: string) => void;
}): SseParser {
	const decoder = new TextDecoder();
	let text = '';
	let event = 'message';
	let data = '';
	let id: string | null = null;

	const emit = () => {
		if (data) {
			onMessage({ event, data: data.replace(/\n$/, ''), id });
		} else if (id !== null) {
			onId?.(id);
		}
		event = 'message';
		data = '';
		id = null;
	};

	const drain = () => {
		let nl = text.indexOf('\n');
		while (nl >= 0) {
			const raw = text.slice(0, nl).replace(/\r$/, '');
			text = text.slice(nl + 1);
			if (raw === '') emit();
			else if (!raw.startsWith(':')) {
				const colon = raw.indexOf(':');
				const field = colon === -1 ? raw : raw.slice(0, colon);
				const value = colon === -1 ? '' : raw.slice(colon + 1).replace(/^ /, '');
				if (field === 'event') event = value;
				else if (field === 'data') data += `${value}\n`;
				else if (field === 'id') id = value;
			}
			nl = text.indexOf('\n');
		}
	};

	return {
		push(chunk) {
			text += decoder.decode(chunk, { stream: true });
			drain();
		},
		end() {
			text += decoder.decode();
			if (text) text += '\n';
			drain();
		}
	};
}
