import Constants from 'expo-constants';
import { copy } from '@trippy/copy';
import { getToken } from './token';

/**
 * The mobile twin of apps/web/src/lib/api.ts.
 *
 * It differs in exactly two ways, and both follow from not being a browser.
 * There is no same-origin proxy, so every request needs an absolute base URL;
 * and there is no cookie jar worth trusting, so the session travels as a bearer
 * token that this module attaches. Everything else, including turning a non-2xx
 * response into a thrown ApiError carrying the server's own message, is
 * deliberately identical, so a screen ported from web keeps its error handling.
 */

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

/**
 * Where the API lives.
 *
 * A phone cannot reach `localhost`, so in development the host is taken from
 * the address Metro is already serving this bundle from: whatever route the
 * bundle arrived by, the API is reachable the same way. `EXPO_PUBLIC_API_URL`
 * overrides it for a tunnel or a deployed build.
 */
function inferBaseUrl(): string {
	const override = process.env.EXPO_PUBLIC_API_URL;
	if (override) return override.replace(/\/$/, '');

	const host = Constants.expoConfig?.hostUri?.split(':')[0];
	return host ? `http://${host}:5175` : 'http://localhost:5175';
}

export const API_BASE = inferBaseUrl();

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
	const { method = 'GET', body, signal } = options;
	const token = await getToken();

	const headers: Record<string, string> = { 'x-trippy-client': 'native' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (token) headers.authorization = `Bearer ${token}`;

	let res: Response;
	try {
		res = await fetch(`${API_BASE}/api${path}`, {
			method,
			signal,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch (err) {
		if (isAbort(err)) throw err;
		throw new ApiError(0, copy.api.unreachable);
	}

	const payload = res.status === 204 ? null : await res.json().catch(() => null);

	if (!res.ok) {
		const message =
			payload &&
			typeof payload === 'object' &&
			typeof (payload as { error?: unknown }).error === 'string'
				? (payload as { error: string }).error
				: copy.api.requestFailed;
		throw new ApiError(res.status, message);
	}

	return payload as T;
}

/**
 * React Native does not expose DOMException, so an abort is recognised by name.
 * The web client can afford `instanceof`; here the shape is all there is.
 */
export function isAbort(err: unknown): boolean {
	return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export type User = { id: string; name: string; email: string };
