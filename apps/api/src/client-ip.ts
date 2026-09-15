import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/**
 * Who is calling, for throttling and per-caller quotas. Never trusted for
 * authority, only for rate limiting.
 *
 * `X-Forwarded-For` is a list that grows left to right as a request passes
 * through proxies: `client, proxy1, proxy2`. A client can put anything it likes
 * at the front, so the *first* value is attacker-controlled and taking it (as
 * this code used to) lets a caller forge a fresh identity per request by
 * prepending an address, sidestepping every per-IP limit. The trustworthy value
 * is the one *our own* proxy appended, which sits at the right-hand end.
 *
 * How many entries to trust from the right is exactly the number of proxies we
 * run in front of the app, `TRIPPY_TRUSTED_PROXIES`. Behind Caddy that is 1, so
 * the last entry is Caddy's view of the immediate client and everything to its
 * left is unverifiable and ignored. With 0 (the default, and local development,
 * where there is no proxy and usually no header) we trust the header not at all
 * and use the socket's own remote address. Reading the header when no proxy is
 * present would be the mirror-image bug: a single spoofed value would let one
 * caller impersonate many, or make everyone look like one client.
 */
export const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRIPPY_TRUSTED_PROXIES ?? 0) || 0);

/**
 * The client address given the forwarded-for header, the socket's own remote
 * address, and how many proxy hops we trust. Pure, so the parsing can be tested
 * against a spoofed multi-hop header without a live server.
 *
 * With `hops` of 0 the header is ignored entirely. Otherwise the value `hops`
 * from the right is returned: that is the address the outermost proxy we control
 * observed and appended. If the header is missing or has fewer entries than the
 * hop count (a request that did not actually traverse that many of our proxies),
 * we fall back to the socket address rather than trust a shorter, forgeable list.
 */
export function pickClientIp(
	forwardedFor: string | undefined,
	remoteAddress: string | undefined,
	hops: number
): string {
	if (hops > 0 && forwardedFor) {
		const parts = forwardedFor
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const index = parts.length - hops;
		if (index >= 0 && parts[index]) return parts[index];
	}
	return remoteAddress ?? 'unknown';
}

/** The client address for a request, using the configured trusted-proxy count. */
export function clientIp(c: Context): string {
	return pickClientIp(
		c.req.header('x-forwarded-for'),
		getConnInfo(c).remote.address,
		TRUSTED_PROXY_HOPS
	);
}
