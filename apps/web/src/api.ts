/**
 * The single place the client talks to the API.
 *
 * Everything goes through one function so that the cross-cutting rules live in
 * one place: send the session cookie, always parse the body, and turn a non-2xx
 * response into a thrown ApiError carrying the server's own message. Callers
 * then only ever handle two shapes, a value or an ApiError, instead of each one
 * re-deciding what `res.ok` should mean.
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
		throw new ApiError(0, 'Could not reach the server. Check your connection.');
	}

	// A 204 has no body to parse, and an error page from a proxy will not be JSON.
	const payload = res.status === 204 ? null : await res.json().catch(() => null);

	if (!res.ok) {
		const message =
			payload &&
			typeof payload === 'object' &&
			typeof (payload as { error?: unknown }).error === 'string'
				? (payload as { error: string }).error
				: 'Something went wrong. Please try again.';
		throw new ApiError(res.status, message);
	}

	return payload as T;
}

export type User = { id: string; name: string; email: string };
