/**
 * Framework-neutral core: types plus pure logic shared by every client.
 *
 * Nothing here may import from a framework, touch the DOM, or use Node APIs.
 * That constraint is the whole point: this package is consumed by the React web
 * app, the API and (later) a React Native app, so the settlement maths, the
 * item-type vocabulary and the time-zone rules exist in exactly one place.
 */
export * from './types';
export * from './settlement';
export * from './split';
export * from './tz';
export * from './layout';
export * from './cover';
export * from './geo';
