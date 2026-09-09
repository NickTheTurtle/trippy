/**
 * Server configuration, read from `process.env`.
 *
 * The API server loads the repo's `.env` with `--env-file`, so these keys are
 * on `process.env` by the time a request is served. Reading it directly (rather
 * than through a framework's env module) keeps this package usable from any
 * Node entry point.
 *
 * Access is deliberately lazy via a getter rather than captured into a const at
 * module load, because the module graph is evaluated before the API server has
 * finished loading its .env file, and a captured value would be permanently
 * undefined.
 */
export const env = {
	get GOOGLE_PLACES_KEY(): string | undefined {
		return process.env.GOOGLE_PLACES_KEY;
	},
	get GOOGLE_MAPS_KEY(): string | undefined {
		return process.env.GOOGLE_MAPS_KEY;
	}
};
