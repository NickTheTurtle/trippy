import { createPublicKey, verify, type JsonWebKeyInput } from 'node:crypto';

/**
 * Verifying the ID tokens Google and Apple sign people in with.
 *
 * An ID token is a JWT the provider signs with a key it publishes as a JWKS. A
 * token that reached us through a browser or a phone could have been written by
 * anyone, so it proves nothing until three things hold: the signature is the
 * provider's (its key, found by `kid`), it was issued to us (`aud` is one of our
 * client ids, so a token Google minted for some other site cannot be replayed
 * here), and it is the one this sign-in asked for (`nonce`), so a token lifted
 * from an earlier sign-in cannot be played again.
 *
 * Both providers sign with RS256 only, so nothing else is accepted: a token
 * naming `none` or an HMAC algorithm is the classic way to make a verifier check
 * a signature against something the attacker chose.
 *
 * Done with `node:crypto` rather than a JWT library. Node reads a JWK directly
 * and verifies RS256 natively; the rest is a few claim comparisons, which are
 * clearer here than behind a dependency's options object.
 */

export interface IdTokenClaims {
	iss: string;
	sub: string;
	aud: string | string[];
	exp: number;
	iat?: number;
	nonce?: string;
	email?: string;
	/** Google sends a boolean; Apple has sent the string "true". */
	email_verified?: boolean | string;
	name?: string;
}

export type VerifyResult = { ok: true; claims: IdTokenClaims } | { ok: false; reason: string };

export interface VerifyOptions {
	jwksUrl: string;
	issuers: string[];
	audiences: string[];
	/** The nonce this sign-in sent. Required: every flow here sends one. */
	nonce: string;
	now?: number;
}

/** Clock difference tolerated between us and the provider. */
const SKEW_SECONDS = 60;
/** How long a fetched key set is trusted before it is fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/**
 * A token naming a key we have not seen refetches the set (the provider has
 * rotated), but not more often than this, so junk `kid`s cannot make every
 * request a fetch.
 */
const JWKS_REFETCH_MS = 5 * 60 * 1000;

/** The fields of a published RSA key this reads; the rest pass through to Node. */
type Jwk = { kty?: string; kid?: string; alg?: string; use?: string; n?: string; e?: string };

let fetcher: typeof fetch = (...args) => fetch(...args);
const keySets = new Map<string, { keys: Jwk[]; at: number }>();

/** Tests stand in for the provider's key endpoint and token endpoint. */
export function setAuthFetch(f: typeof fetch): void {
	fetcher = f;
	keySets.clear();
}

/** The fetch the sign-in code uses, so tests replace it in one place. */
export function authFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetcher(input, init);
}

async function loadKeys(url: string): Promise<Jwk[]> {
	const res = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) throw new Error(`key set ${res.status}`);
	const body = (await res.json()) as { keys?: Jwk[] };
	const keys = Array.isArray(body.keys) ? body.keys : [];
	keySets.set(url, { keys, at: Date.now() });
	return keys;
}

async function keyFor(url: string, kid: string): Promise<Jwk | undefined> {
	const cached = keySets.get(url);
	const fresh = cached && Date.now() - cached.at < JWKS_TTL_MS;
	let keys = fresh ? cached.keys : await loadKeys(url);
	let key = keys.find((k) => k.kid === kid);
	if (!key && fresh && Date.now() - cached.at > JWKS_REFETCH_MS) {
		keys = await loadKeys(url);
		key = keys.find((k) => k.kid === kid);
	}
	return key;
}

function decodePart<T>(part: string): T | null {
	try {
		return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
	} catch {
		return null;
	}
}

export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<VerifyResult> {
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };
	const [h, p, s] = parts;
	const header = decodePart<{ alg?: string; kid?: string }>(h);
	const claims = decodePart<IdTokenClaims>(p);
	if (!header || !claims) return { ok: false, reason: 'malformed' };
	if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
		return { ok: false, reason: 'algorithm' };
	}

	let jwk: Jwk | undefined;
	try {
		jwk = await keyFor(opts.jwksUrl, header.kid);
	} catch {
		return { ok: false, reason: 'keys unavailable' };
	}
	if (!jwk || jwk.kty !== 'RSA') return { ok: false, reason: 'unknown key' };
	let signed = false;
	try {
		signed = verify(
			'RSA-SHA256',
			Buffer.from(`${h}.${p}`),
			createPublicKey({
				key: jwk as JsonWebKeyInput['key'],
				format: 'jwk'
			}),
			Buffer.from(s, 'base64url')
		);
	} catch {
		signed = false;
	}
	if (!signed) return { ok: false, reason: 'signature' };

	const now = Math.floor((opts.now ?? Date.now()) / 1000);
	if (!opts.issuers.includes(claims.iss)) return { ok: false, reason: 'issuer' };
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.some((a) => opts.audiences.includes(a))) return { ok: false, reason: 'audience' };
	if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) {
		return { ok: false, reason: 'expired' };
	}
	if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > now) {
		return { ok: false, reason: 'issued in the future' };
	}
	if (!opts.nonce || claims.nonce !== opts.nonce) return { ok: false, reason: 'nonce' };
	if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'subject' };
	return { ok: true, claims };
}

/** `email_verified` as a boolean, whichever way the provider wrote it. */
export function emailVerified(claims: IdTokenClaims): boolean {
	return claims.email_verified === true || claims.email_verified === 'true';
}
