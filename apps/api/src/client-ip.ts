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
 * `TRIPPY_TRUSTED_PROXIES` says how far in from the right we are willing to
 * read, in one of two forms:
 *
 *  - **A count.** `1` behind Caddy: the last entry is Caddy's view of the
 *    immediate client, and everything to its left is unverifiable and ignored.
 *  - **A list of addresses.** `10.0.0.2,10.0.0.3`: entries are skipped from the
 *    right for as long as they name a proxy we run, and the first address that
 *    is not one of ours is the client. This is the stronger form when the
 *    number of hops can vary (a health checker that reaches the app directly, a
 *    second ingress added later), because it is stated in terms of what we
 *    actually operate rather than a count that silently becomes wrong.
 *
 * Unset, or `0`, means **no proxy is trusted and the header is ignored
 * entirely**, which is the safe default and the right answer for local
 * development. Reading the header when no proxy is present is the mirror-image
 * bug: a single spoofed value would let one caller mint identities at will, or
 * make everyone look like one client and throttle the whole world together.
 */

/** Either a hop count or the addresses of the proxies we operate. */
export type ProxyTrust = number | string[];

/**
 * Reduce one forwarded-for entry (or a socket address) to a comparable address,
 * or null when it is not one.
 *
 * Real headers carry more than bare addresses: a port (`203.0.113.7:54321`,
 * which several proxies append), an IPv6 literal in brackets
 * (`[2001:db8::1]:443`), an IPv4-mapped IPv6 address (`::ffff:203.0.113.7`,
 * which is what a dual-stack Node socket reports), and the RFC 7239 placeholder
 * `unknown` or an obfuscated `_hidden` identifier. Comparing these raw would
 * make the same client two different throttle keys depending on which form the
 * proxy used, and that is a per-IP limit with a trivial bypass.
 */
export function normalizeIp(raw: string | undefined): string | null {
	if (!raw) return null;
	let value = raw.trim().toLowerCase();
	if (!value) return null;
	// Quoted forms, as a Forwarded-style value may use.
	value = value.replace(/^"|"$/g, '');
	// RFC 7239 allows an identifier to be withheld or obfuscated. Either way it
	// names nobody, so it cannot be a throttle key.
	if (value === 'unknown' || value.startsWith('_')) return null;
	// [2001:db8::1]:443 or [2001:db8::1]
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
	if (bracketed) value = bracketed[1];
	else if (/^[\d.]+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
	// A dual-stack socket reports IPv4 clients as ::ffff:a.b.c.d.
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
	if (mapped) value = mapped[1];
	return value || null;
}

/**
 * Parse `TRIPPY_TRUSTED_PROXIES`. A bare number is a hop count; anything else is
 * read as a comma-separated list of proxy addresses. Garbage reads as 0,
 * because an unparseable setting must never be allowed to mean "trust the
 * header": failing closed costs a misconfigured deployment some shared
 * throttling, while failing open costs it every per-IP limit it has.
 */
export function parseProxyTrust(raw: string | undefined): ProxyTrust {
	const value = (raw ?? '').trim();
	if (!value) return 0;
	if (/^\d+$/.test(value)) return Number(value);
	const addresses = value
		.split(',')
		.map((s) => normalizeIp(s))
		.filter((s): s is string => !!s);
	return addresses.length ? addresses : 0;
}

/** What this process trusts in front of it, read once at startup. */
export const TRUSTED_PROXIES: ProxyTrust = parseProxyTrust(process.env.TRIPPY_TRUSTED_PROXIES);

function isTrustedProxy(address: string | null, trusted: string[]): boolean {
	return !!address && trusted.includes(address);
}

/**
 * The client address given the forwarded-for header, the socket's own remote
 * address, and what we trust in front of us. Pure, so the parsing can be tested
 * against a spoofed multi-hop header without a live server.
 *
 * Count mode: with `0` the header is ignored entirely; otherwise the entry
 * `trust` from the right is returned, which is the address the outermost proxy
 * we control observed and appended. If the header is missing or has fewer
 * entries than the hop count (a request that did not really traverse that many
 * of our proxies) we fall back to the socket address rather than trust a
 * shorter, forgeable list.
 *
 * List mode: entries are dropped from the right while they name one of our own
 * proxies, and the first one that does not is the client. If the request did
 * not arrive from one of our proxies at all, the header is ignored, because
 * only a proxy we run can be trusted to have appended anything truthful. If
 * every entry names one of ours, there is no client address to read and we fall
 * back to the socket.
 */
export function pickClientIp(
	forwardedFor: string | undefined,
	remoteAddress: string | undefined,
	trust: ProxyTrust
): string {
	const socket = normalizeIp(remoteAddress);
	const fallback = socket ?? 'unknown';

	const parts = (forwardedFor ?? '')
		.split(',')
		.map((s) => normalizeIp(s))
		.filter((s): s is string => !!s);

	if (Array.isArray(trust)) {
		// The immediate peer must itself be one of ours, or the header is just
		// something a direct caller typed.
		if (!isTrustedProxy(socket, trust)) return fallback;
		for (let i = parts.length - 1; i >= 0; i--) {
			if (!isTrustedProxy(parts[i], trust)) return parts[i];
		}
		return fallback;
	}

	if (trust > 0 && parts.length) {
		const index = parts.length - trust;
		if (index >= 0 && parts[index]) return parts[index];
	}
	return fallback;
}

/** The client address for a request, using the configured trusted-proxy setting. */
export function clientIp(c: Context): string {
	return pickClientIp(
		c.req.header('x-forwarded-for'),
		getConnInfo(c).remote.address,
		TRUSTED_PROXIES
	);
}
