import { copy } from '../copy';

/**
 * The single place the client talks to the API.
 *
 * Everything goes through one function so that the cross-cutting rules live in
 * one place: send the session cookie, always parse the body, and turn a non-2xx
 * response into a thrown ApiError carrying the server's own message. Callers
 * then only ever handle two shapes, a value or an ApiError, instead of each one
 * re-deciding what `res.ok` should mean.
 *
 * **The one line of console noise this cannot quieten.** A signed-out visit
 * asks `GET /auth/me`, is answered 401, and the browser itself prints "Failed
 * to load resource: the server responded with a status of 401" in red. That
 * line is emitted by the network stack for any 4xx, before a single line of
 * this file runs; there is no JavaScript that removes it, and catching the
 * error (which `auth.tsx` already does, deliberately and only for 401) does not
 * touch it. The client cannot skip the request either: the session cookie is
 * httpOnly, so asking the server is the only way to find out whether there is
 * a session.
 *
 * The fix belongs to the API and is one line there: `GET /auth/me` should
 * answer **200 with `{ user: null }`** for a signed-out visitor. "Is anybody
 * signed in?" is a question with a legitimate negative answer, not a refused
 * request, and 401 is reserved for a request that needed a session and did not
 * have one. Measured rather than assumed: it is every *signed-out* load that
 * prints it, and no signed-in load does.
 */

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
	const { method = 'GET', body, signal } = options;

	let res: Response;
	try {
		res = await fetch(`/api${path}`, {
			method,
			signal,
			// The session cookie is httpOnly, so the client cannot read or attach it
			// by hand. Same-origin is the default in modern browsers, but stating it
			// keeps the guarantee explicit if this ever moves to a separate host.
			credentials: 'same-origin',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch (err) {
		// An abort is the caller deliberately cancelling, not a failure to report.
		if (err instanceof DOMException && err.name === 'AbortError') throw err;
		throw new ApiError(0, copy.api.unreachable);
	}

	// A 204 has no body to parse, and an error page from a proxy will not be JSON.
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

export type User = { id: string; name: string; email: string };
