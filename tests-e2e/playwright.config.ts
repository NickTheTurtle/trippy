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

function setEnv(name: string, value: string): string {
	return `set "${name}=${value}"`;
}

export default defineConfig({
	testDir: '.',
	testMatch: ['**/*.spec.ts'],
	timeout: 60_000,
	expect: {
		timeout: 10_000
	},
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	reporter: [['list']],
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
			command: `${setEnv('PORT', String(apiPort))} && ${setEnv('TRIPPY_DB', dbPath)} && npx tsx apps\\api\\src\\index.ts`,
			url: `${apiURL}/health`,
			cwd: repoRoot,
			reuseExistingServer: false,
			timeout: 120_000
		},
		{
			command: `npx vite --config tests-e2e\\vite.e2e.config.ts --host 127.0.0.1`,
			url: webURL,
			cwd: repoRoot,
			reuseExistingServer: false,
			timeout: 120_000
		}
	]
});
