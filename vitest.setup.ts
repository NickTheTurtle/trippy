/**
 * What every unit test file gets before it runs.
 *
 * The rule this enforces: **an automated run never calls a paid provider, and
 * never calls any network service at all.** Google Places and Routes are billed
 * per request, so a suite that reaches them costs money on every run, returns
 * different answers on different days, and fails when a third party has a bad
 * afternoon. Relying on "do not put a key in your .env while testing" is not
 * enough, because breaking that convention is silent and the evidence arrives a
 * month later on an invoice.
 *
 * Two independent guards, because either one alone can be worked around:
 *
 *  1. *No key.* Any Google key inherited from the developer's shell is removed
 *     from `process.env` before a single module is imported. Tests that want to
 *     exercise a Google code path set their own obviously fake key, which is
 *     what `places.test.ts` and `routing.test.ts` already do.
 *  2. *No network.* `globalThis.fetch` is replaced with a function that throws.
 *     A test that means to exercise a provider stubs `fetch` itself (with
 *     `vi.stubGlobal`) and answers from a fixture; anything that does not is a
 *     test that was about to make a real request, and it now fails loudly with
 *     the URL it wanted instead of quietly succeeding at someone's expense.
 *
 * Vitest does not load the repo's `.env` into `process.env`, so a key only
 * reaches here when the developer exported one in their shell. Guard 1 exists
 * precisely for that case.
 */
for (const name of ['GOOGLE_SERVER_KEY', 'GOOGLE_PLACES_KEY', 'GOOGLE_MAPS_KEY']) {
	delete process.env[name];
}

/** Tests that deliberately exercise the offline guard flip this per case. */
delete process.env.TRIPPY_OFFLINE_PROVIDERS;

function blockedFetch(input: unknown): never {
	const url =
		typeof input === 'string'
			? input
			: input instanceof URL
				? input.href
				: ((input as { url?: string })?.url ?? String(input));
	throw new Error(
		`Unit tests must not make network requests. Something tried to fetch ${url}. ` +
			'Stub fetch with vi.stubGlobal in the test, or use the keyless offline path.'
	);
}

globalThis.fetch = blockedFetch as unknown as typeof fetch;
