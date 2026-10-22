/**
 * Password hashing that works on both runtimes.
 *
 * The Pi hashed with `node:crypto` scrypt and the Worker with WebCrypto PBKDF2, which meant one
 * account could not log in on both — wrong, because this is one product with one backend seen from
 * two frontends. The shared format is now PBKDF2-SHA256 through WebCrypto, which Node 24 has too.
 *
 * Stored as one string, so there is no "which column holds what" question:
 *
 *     pbkdf2$<iterations>$<salt-hex>$<hash-hex>
 *
 * Legacy rows (scrypt, salt in a separate column) still verify on the Pi and are upgraded in place on
 * the next successful login. The Worker cannot verify them at all — it has no scrypt — so a legacy
 * account's first sign-in must happen on the Pi, where the upgrade runs.
 */
import { scryptSync, timingSafeEqual } from "node:crypto";

import {
  constantTimeEqualHex,
  fromHex,
  hashPassword as hashPortable,
  verifyPasswordCore,
} from "./password-core";

export { hashPassword } from "./password-core";

/**
 * Verify against either format: the portable one, or a legacy scrypt row (Pi-created before accounts
 * were shared). A legacy match comes back with the upgraded value, so the account migrates itself the
 * next time its owner signs in — after which it works on Workers too.
 */
export async function verifyPassword(
  password: string,
  stored: string | null,
  legacySalt?: string | null,
): Promise<{ ok: boolean; upgrade?: string }> {
  if (!stored) return { ok: false };

  if (stored.startsWith("pbkdf2$")) {
    return { ok: await verifyPasswordCore(password, stored) };
  }

  if (!legacySalt) return { ok: false };
  const expected = Buffer.from(stored, "hex");
  const actual = scryptSync(password, legacySalt, expected.length);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false };
  return { ok: true, upgrade: await hashPortable(password) };
}
