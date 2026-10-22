/**
 * Password hashing on Workers.
 *
 * The Pi uses `scrypt` from `node:crypto`; Workers have no Node built-ins and no scrypt, so this is
 * PBKDF2-SHA256 through WebCrypto — the same idea (slow, salted, per-user) in the primitive the
 * runtime actually has.
 *
 * The two are deliberately not interchangeable: a hash made on one cannot be verified on the other.
 * That is fine here because the Pi and D1 hold different databases, and it is called out so nobody
 * is surprised when a session from the Pi fails on Workers.
 */
const ITERATIONS = 150_000;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: ITERATIONS },
    key,
    KEY_BITS,
  );
  return toHex(bits);
}

export function newSalt(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  return derive(password, salt);
}

/** Constant-time comparison, so a wrong password cannot be found by timing. */
export async function verifyPassword(password: string, salt: string, expectedHex: string): Promise<boolean> {
  const actual = fromHex(await derive(password, salt));
  const expected = fromHex(expectedHex);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(digest);
}
