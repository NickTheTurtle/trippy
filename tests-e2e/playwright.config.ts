import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const tmpRoot = resolve(here, '.tmp');
mkdirSync(tmpRoot, { recursive: true });

const webPort = Number(process.env.E2E_WEB_PORT ?? 5184);
const apiPort = Number(process.env.E2E_API_PORT ?? 5185);
const webURL = process.env.E2E_WEB_URL ?? `http://localhost:${webPort}`;
const apiURL = process.env.E2E_API_URL ?? `http://localhost:${apiPort}/api`;
const dbPath = resolve(process.env.E2E_TRIPPY_DB ?? resolve(tmpRoot, 'trippy-e2e-manual.db'));

process.env.E2E_API_URL = apiURL;
process.env.E2E_TRIPPY_DB = dbPath;

export default defineConfig({
	testDir: '.',
	testMatch: ['**/*.spec.ts'],
	timeout: 60_000,
	expect: {
		timeout: 10_000
	},
	fullyParallel: false,
	// One worker, not one file at a time. Every spec talks to the same throwaway
	// SQLite database through the same API server, and SQLite takes a single
	// writer: two files running side by side fail with SQLITE_BUSY ("database is
	// locked") somewhere in whichever one wrote second. `fullyParallel: false`
	// does not cover this, because it only serializes tests *within* a file and
	// still hands separate files to separate workers.
	workers: 1,
	retries: process.env.CI ? 2 : 0,
	// list keeps the console readable locally and in CI logs; html produces the
	// report the CI job uploads as an artifact. open: 'never' stops a CI run (or
	// a local run) from trying to launch a browser. The html output lands in
	// tests-e2e/playwright-report and the trace/screenshot output in
	// tests-e2e/test-results, both already gitignored.
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL: webURL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' }
		}
	],
	webServer: [
		{
			// Every spec registers its own account from one address, which is exactly
			// what the registration throttle exists to slow down. The limit is raised
			// rather than switched off so the code path under test is the real one.
			//
			// Environment is passed through Playwright's `env` option instead of a
			// shell `set`, and the entry path uses forward slashes (Node accepts
			// them on Windows too), so this one command runs identically on a Linux
			// CI runner and on the maintainer's Windows machine.
			command: 'npx tsx apps/api/src/index.ts',
			env: {
				PORT: String(apiPort),
				TRIPPY_DB: dbPath,
				TRIPPY_REGISTER_LIMIT: '10000'
			},
			url: `${apiURL}/health`,
			cwd: repoRoot,
			reuseExistingServer: false,
			timeout: 120_000
		},
		{
			// The Vite config reads its ports from E2E_WEB_PORT / E2E_API_PORT, so
			// they are passed explicitly to keep the web server in step with the
			// ports this config computed.
			command: 'npx vite --config tests-e2e/vite.e2e.config.ts --host 127.0.0.1',
			env: {
				E2E_WEB_PORT: String(webPort),
				E2E_API_PORT: String(apiPort)
			},
			url: webURL,
			cwd: repoRoot,
			reuseExistingServer: false,
			timeout: 120_000
		}
	]
});
