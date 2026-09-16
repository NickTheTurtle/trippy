import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = (path: string) => fileURLToPath(new URL(`./packages/core/src/${path}`, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@trippy/core/settlement', replacement: core('settlement.ts') },
			{ find: '@trippy/core/split', replacement: core('split.ts') },
			{ find: '@trippy/core/tz', replacement: core('tz.ts') },
			{ find: '@trippy/core/layout', replacement: core('layout.ts') },
			{ find: '@trippy/core/cover', replacement: core('cover.ts') },
			{ find: '@trippy/core/geo', replacement: core('geo.ts') },
			{ find: '@trippy/core/travel', replacement: core('travel.ts') },
			{ find: '@trippy/core/plan', replacement: core('plan.ts') },
			{ find: '@trippy/core/currency', replacement: core('currency.ts') },
			// `validate` is aliased like the rest so a route under test resolves it
			// the way the app does. Without it, the first test to load a route that
			// validates a field fails with ERR_MODULE_NOT_FOUND rather than a
			// failed assertion, which is a confusing way to learn about a missing
			// line in a config.
			{ find: '@trippy/core/validate', replacement: core('validate.ts') },
			{ find: '@trippy/core/sample', replacement: core('sample.ts') },
			{ find: '@trippy/core/types', replacement: core('types.ts') },
			{ find: '@trippy/core', replacement: core('index.ts') }
		]
	},
	test: {
		include: [
			'packages/core/test/**/*.test.ts',
			'packages/server/test/**/*.test.ts',
			'apps/api/test/**/*.test.ts'
		],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text'],
			include: ['packages/core/src/**/*.ts']
		}
	}
});
