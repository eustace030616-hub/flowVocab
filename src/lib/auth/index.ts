/**
 * Auth, as a module you can mount anywhere.
 *
 * This was `src/lib/learner/auth.ts` — one file inside a language-learning app. It is the only part of
 * Flowwing that other apps use (bookreader signs people in through it), so it now lives on its own,
 * with a route factory that any Hono host can mount: the Pi today, a Worker if it ever has to move.
 *
 *   service.ts        register / login / sessions / verify — the logic, over the StoreDriver seam
 *   password.ts       verify, including the legacy scrypt format
 *   password-core.ts  the portable hash format, shared by both runtimes
 *   routes.ts         POST /service/register · /service/login · /service/password, guarded by a secret
 */
export * from "./service";
export { serviceAuthRoutes } from "./routes";
