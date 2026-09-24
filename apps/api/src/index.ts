import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { session, requireUser, limitBody } from './middleware';
import { billingGate, quota429 } from './provider-quota';
import { fail } from './respond';
import { auth } from './routes/auth';
import { account } from './routes/account';
import { trips } from './routes/trips';
import { placePhoto } from './routes/place-photo';
import { ses } from './routes/ses';
import { ensureDemoAccount, purgeExpiredSessions } from '@trippy/server/auth';
import { closeAll } from '@trippy/server/events';
import { env } from '@trippy/server/env';
import { searchCities } from '@trippy/server/geocode';
import { providerStatus } from '@trippy/server/places';
import { routingStatus } from '@trippy/server/routing';
import type { SessionUser } from '@trippy/server/auth';

/**
 * Standalone JSON API. It owns the database and the Google keys, so the web and
 * (later) native clients hold no credentials and share one implementation.
 *
 * Everything is mounted under /api because the web dev server proxies that
 * prefix, which keeps the browser on a single origin: no CORS preflights, and
 * the session cookie stays first-party. Production is expected to sit behind
 * one host for the same reason.
 */
const app = new Hono<{ Variables: { user: SessionUser | null } }>();

/**
 * CORS, for development only.
 *
 * The native client is not a browser and never sends a preflight, and the web
 * client is proxied onto one origin, so neither needs this in production. What
 * does need it is Expo's own web preview, which serves the React Native bundle
 * from Metro's port and so is genuinely cross-origin. Credentials are not
 * enabled: a cross-origin caller authenticates with a bearer token, and leaving
 * the cookie out of the allowance means this cannot be used to ride a browser
 * session.
 */
if (process.env.NODE_ENV !== 'production') {
	app.use(
		'/api/*',
		cors({
			origin: (origin) =>
				/^http:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+):\d+$/.test(origin) ? origin : null,
			allowHeaders: ['content-type', 'authorization', 'x-trippy-client'],
			allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
		})
	);
}

app.use('*', session);
app.use('/api/*', limitBody);

void env.GOOGLE_SERVER_KEY;

/**
 * Liveness plus which provider is actually answering, for places and routing.
 *
 * `provider` used to be `activeProvider()`, which only says whether a key is
 * configured. With a broken key that reported "google" while every search was
 * being served by OSM, so the one endpoint whose job is to say what is wrong
 * was the thing hiding it. It now reports `serving`, and carries `configured`
 * and the most recent Google failure beside it so the discrepancy is visible
 * rather than inferred.
 *
 * Routing is reported the same way and from the same record. It used to say
 * nothing at all: its failures were swallowed into a `null` and a board ran on
 * straight-line estimates with no trace anywhere.
 *
 * Both halves survive a restart, which matters here more than it sounds: this
 * process runs under `tsx watch`, so it restarts on every file save, and a
 * report built only from this process's memory went back to green after each
 * one. See `provider-health.ts` for why that is persisted rather than probed.
 *
 * `ok` stays true in a degraded state on purpose: searches and journeys are
 * still answered, just by the free providers. That is degraded, not down, and a
 * health check that fails on it would page for something the app is handling.
 * `degraded` is the field to alert on, and it is true when either half is.
 */
app.get('/api/health', (c) => {
	const { configured, serving, lastFailure } = providerStatus();
	const routing = routingStatus();
	return c.json({
		ok: true,
		provider: serving,
		providerConfigured: configured,
		degraded: serving !== configured || routing.degraded,
		lastFailure,
		routing
	});
});
app.route('/api/auth', auth);
app.route('/api/account', account);
app.route('/api/trips', trips);
app.route('/api/place-photo', placePhoto);

/**
 * SES bounce and complaint receiver, delivered over SNS. Deliberately mounted
 * here, not under `requireUser`: SNS is unauthenticated, so the endpoint
 * authenticates the caller by the message signature instead. See routes/ses.ts.
 */
app.route('/api/ses', ses);

/**
 * City lookup for the trip editor. It is not scoped to a trip because it is used
 * while creating one, but it is still behind a session: it costs a geocoder call
 * per request and must not be an open proxy. Per-caller quota is applied for the
 * same reason it is on place search: a signed-in caller could otherwise loop it.
 */
app.get('/api/citysearch', requireUser, async (c) => {
	try {
		return c.json({
			results: await searchCities(c.req.query('q') ?? '', billingGate(c, c.get('user')!.id))
		});
	} catch (err) {
		return quota429(c, err);
	}
});

app.notFound((c) => fail(c, 404, 'Not found.'));

app.onError((err, c) => {
	// Log the real error, return a generic one: stack traces and SQL text in a
	// response body are an information leak.
	console.error(err);
	return c.json({ error: 'Something went wrong' }, 500);
});

if (process.env.NODE_ENV !== 'production') ensureDemoAccount();

// Expired sessions are otherwise only cleared when that exact session is looked
// up again, which an abandoned one never is. Once at boot is enough for a table
// whose rows live 30 days.
purgeExpiredSessions();

const port = Number(process.env.PORT ?? 5175);
// `HOST` unset keeps Node's default (every interface), which is what lets a
// phone on the LAN reach a dev server. The deploy sets 127.0.0.1: Caddy runs on
// the same box and proxies to loopback, so a socket on the public interface is
// only a way around the proxy, its TLS and its security headers.
const hostname = env.HOST;
serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, (info) => {
	console.log(`api listening on http://${hostname ?? 'localhost'}:${info.port}`);
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
