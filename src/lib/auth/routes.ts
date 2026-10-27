/**
 * The three service endpoints, as a mountable unit.
 *
 * Copied out of `reader-api.ts` so the Worker is no longer the only host that can answer them: the Pi
 * serves the same contract now, which is what lets bookreader keep signing people in after the Worker
 * is gone.
 */
import type { Hono } from "hono";
import { login, register } from "./service";

/* eslint-disable @typescript-eslint/no-explicit-any -- the host owns the context's variable map */
export function serviceAuthRoutes(
  app: Hono<any>,
  options: { secret?: string },
): void {
  app.use("/service/*", async (c: any, next: any) => {
    const given = c.req.header("X-Flowwing-Service");
    if (!options.secret || given !== options.secret) {
      return c.json({ error: "service access only" }, 403);
    }
    await next();
  });

  app.post("/service/register", async (c: any) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = await register(String(body.username ?? ""), String(body.password ?? ""), undefined, c.get("store"));
    if (!result.ok) {
      return c.json(
        { error: result.error === "taken" ? "taken" : "missing" },
        result.error === "taken" ? 409 : 400,
      );
    }
    return c.json({ userId: result.user.userId, username: result.user.username, track: result.user.track }, 201);
  });

  app.post("/service/login", async (c: any) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = await login(String(body.username ?? ""), String(body.password ?? ""), { store: c.get("store") });
    if (!result.ok) return c.json({ error: "bad-credentials" }, 401);
    return c.json({ userId: result.user.userId, username: result.user.username, track: result.user.track });
  });

  /**
   * Accept a hash the Pi has just upgraded.
   *
   * Workers cannot run PBKDF2 above 100,000 iterations, so an account hashed at a higher count cannot be
   * verified there at all. The Pi can (Node has no such cap), re-hashes at the portable count and sends
   * the result — the caller has already proved the password, which is why this is guarded by the service
   * secret rather than by a password.
   */
  app.post("/service/password", async (c: any) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; passwordHash?: string };
    if (!body.username || !body.passwordHash) return c.json({ error: "username and passwordHash required" }, 400);
    await c.get("store").run(
      "UPDATE users SET passwordHash = ?, passwordSalt = NULL, updatedAt = ? WHERE username = ?",
      body.passwordHash,
      Date.now(),
      body.username,
    );
    return c.json({ ok: true });
  });
}
