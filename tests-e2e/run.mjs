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
		E2E_TRIPPY_DB: dbPath
	}
});

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
