/**
 * Re-export of the app's copy for the specs to assert against.
 *
 * Imported from the package source by relative path rather than as `@trippy/copy`
 * on purpose: that specifier resolves through a node_modules junction, which
 * Playwright's transpiler skips, so a `.ts` behind it would fail to load. The
 * source lives outside node_modules and is transpiled normally. Assert against
 * these values, never hardcoded strings, so a reword does not fail the suite.
 */
export { copy } from '../../packages/copy/src/copy';
export { formatDay, formatMoney } from '../../packages/copy/src/format';
