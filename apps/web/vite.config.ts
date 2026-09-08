import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],

	server: {
		port: 5174,
		// The API owns the database and the Google keys. Proxying in dev keeps the
		// browser on one origin, so there are no CORS preflights and cookies are
		// first-party, which is what production will look like behind a single host.
		proxy: {
			'/api': {
				target: 'http://localhost:5175',
				changeOrigin: true
			}
		},
		watch: {
			// Visual Studio holds an exclusive lock on the .vsidx files under .vs/,
			// and chokidar's attempt to watch them throws EBUSY and kills the dev
			// server. Nothing in these folders is a build input.
			ignored: ['**/.vs/**', '**/data/**']
		}
	}
});
