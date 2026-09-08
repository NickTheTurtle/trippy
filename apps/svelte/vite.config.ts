import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	// The server modules moved to @trippy/server and no longer import
	// `$env/dynamic/private`, because that only resolves inside SvelteKit and the
	// standalone API needs them too. They read `process.env` instead, which Vite
	// does not populate on its own, so load the .env files into it here. Without
	// this, a missing GOOGLE_PLACES_KEY makes place search silently fall back to
	// the keyless OpenStreetMap provider rather than failing loudly.
	Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

	return {
		plugins: [
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
				// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
				// See https://svelte.dev/docs/kit/adapters for more information about adapters.
				adapter: adapter()
			})
		],

		server: {
			watch: {
				// Visual Studio keeps an exclusive lock on the .vsidx files under .vs/,
				// so chokidar's attempt to watch them throws EBUSY and takes the whole
				// dev server down. Nothing in these folders is a build input.
				ignored: ['**/.vs/**', '**/data/**']
			}
		}
	};
});
