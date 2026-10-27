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
export { hashPassword, hashToken, verifyPasswordCore as verifyStored } from "../../src/lib/auth/password-core";

/** The same salt/format helper as the Pi, re-exported so both sides call one implementation. */
export { newSaltHex as newSalt } from "../../src/lib/auth/password-core";
