/**
 * The formatters now live in @trippy/copy so web and mobile render the same
 * money and dates. This re-export keeps every existing `lib/format` import
 * working.
 */
export * from '@trippy/copy/format';
