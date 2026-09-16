import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = resolve(here, '.tmp');
mkdirSync(tmpRoot, { recursive: true });

const dbPath = resolve(tmpRoot, `trippy-e2e-${process.pid}-${Date.now()}-${randomUUID()}.db`);
const cli = resolve(here, '..', 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cli, 'test'], {
	stdio: 'inherit',
	cwd: here,
	env: {
		...process.env,
		E2E_TRIPPY_DB: dbPath,
		// Belt to the Playwright config's braces: whatever this harness spawns,
		// directly or indirectly, must not call a paid provider. See the note in
		// playwright.config.ts.
		TRIPPY_OFFLINE_PROVIDERS: '1'
	}
});

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
