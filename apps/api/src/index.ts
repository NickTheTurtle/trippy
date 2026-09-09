import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { session, requireUser } from './middleware';
import { fail } from './respond';
import { auth } from './routes/auth';
import { account } from './routes/account';
import { trips } from './routes/trips';
import { placePhoto } from './routes/place-photo';
import { ensureDemoAccount } from '@trippy/server/auth';
import { closeAll } from '@trippy/server/events';
import { searchCities } from '@trippy/server/geocode';

/**
 * Standalone JSON API. It owns the database and the Google keys, so the web and
 * (later) native clients hold no credentials and share one implementation.
 *
 * Everything is mounted under /api because the web dev server proxies that
 * prefix, which keeps the browser on a single origin: no CORS preflights, and
 * the session cookie stays first-party. Production is expected to sit behind
 * one host for the same reason.
 */
const app = new Hono();

app.use('*', session);

app.get('/api/health', (c) => c.json({ ok: true, provider: process.env.GOOGLE_PLACES_KEY ? 'google' : 'osm' }));
app.route('/api/auth', auth);
app.route('/api/account', account);
app.route('/api/trips', trips);
app.route('/api/place-photo', placePhoto);

/**
 * City lookup for the trip editor. It is not scoped to a trip because it is used
 * while creating one, but it is still behind a session: it costs a geocoder call
 * per request and must not be an open proxy.
 */
app.get('/api/citysearch', requireUser, async (c) =>
	c.json({ results: await searchCities(c.req.query('q') ?? '') })
);

app.notFound((c) => fail(c, 404, 'Not found'));

app.onError((err, c) => {
	// Log the real error, return a generic one: stack traces and SQL text in a
	// response body are an information leak.
	console.error(err);
	return c.json({ error: 'Something went wrong' }, 500);
});

if (process.env.NODE_ENV !== 'production') ensureDemoAccount();

const port = Number(process.env.PORT ?? 5175);
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`api listening on http://localhost:${info.port}`);
});

/**
 * Every open SSE stream is a socket this process is holding. On the way out they
 * are closed explicitly, with reason `shutdown`, so each client sees its stream
 * end and reconnects deliberately rather than sitting on a half-open connection
 * waiting for an event that will never come.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		closeAll();
		process.exit(0);
	});
}
