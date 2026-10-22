/**
 * Password hashing, portable to every runtime this app runs on.
 *
 * WebCrypto only — no `node:crypto`, no imports at all — so the identical code runs on the Pi (Node
 * 24) and on Cloudflare Workers. That is what makes one account usable from either frontend: the
 * stored value is a string both sides can read.
 *
 *     pbkdf2$<iterations>$<salt-hex>$<hash-hex>
 *
 * The comparison is constant-time written in plain JavaScript, because `timingSafeEqual` is a Node
 * function and this module must not depend on one.
 */
const ITERATIONS = 150_000;
const KEY_BITS = 256;
const encoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Length-independent, value-independent comparison of two hex strings. */
export function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  let diff = 0;
  for (let i = 0; i < aHex.length; i += 1) diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  return diff === 0;
}

export function newSaltHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function derive(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(fromHex(saltHex)), iterations },
    key,
    KEY_BITS,
  );
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = newSaltHex();
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

export async function verifyPasswordCore(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2$")) return false;
  const [, iterationsText, salt, expected] = stored.split("$");
  if (!salt || !expected) return false;
  const actual = await derive(password, salt, Number(iterationsText));
  return constantTimeEqualHex(actual, expected);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(digest);
}
