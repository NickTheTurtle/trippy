import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from '../src/sse';

const enc = new TextEncoder();

function parse(chunks: string[]): { messages: SseMessage[]; ids: string[] } {
	const messages: SseMessage[] = [];
	const ids: string[] = [];
	const parser = createSseParser({
		onMessage: (message) => messages.push(message),
		onId: (id) => ids.push(id)
	});
	for (const chunk of chunks) parser.push(enc.encode(chunk));
	parser.end();
	return { messages, ids };
}

describe('createSseParser', () => {
	it('parses frames split across chunks', () => {
		const { messages } = parse(['id: 1\nevent: tr', 'ip\ndata: {"ok":', 'true}\n\n']);
		expect(messages).toEqual([{ id: '1', event: 'trip', data: '{"ok":true}' }]);
	});

	it('accepts CRLF line endings', () => {
		const { messages } = parse(['id: 2\r\nevent: reset\r\ndata: {}\r\n\r\n']);
		expect(messages).toEqual([{ id: '2', event: 'reset', data: '{}' }]);
	});

	it('keeps multibyte UTF-8 split across chunks', () => {
		const bytes = enc.encode('event: trip\ndata: {"city":"東京"}\n\n');
		const messages: SseMessage[] = [];
		const parser = createSseParser({ onMessage: (message) => messages.push(message) });
		parser.push(bytes.slice(0, bytes.length - 2));
		parser.push(bytes.slice(bytes.length - 2));
		parser.end();
		expect(messages).toEqual([{ id: null, event: 'trip', data: '{"city":"東京"}' }]);
	});

	it('reports id-only frames without emitting messages', () => {
		const { messages, ids } = parse(['id: baseline\n\n']);
		expect(messages).toEqual([]);
		expect(ids).toEqual(['baseline']);
	});
});
