/**
 * Server configuration, read from `process.env`.
 *
 * This exists because these modules used to import `$env/dynamic/private`,
 * which only resolves inside SvelteKit. The standalone API and the SvelteKit
 * app both populate `process.env` (the API via `--env-file`, SvelteKit via
 * Vite's own .env loading), so reading it directly is the one form that works
 * in both.
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
