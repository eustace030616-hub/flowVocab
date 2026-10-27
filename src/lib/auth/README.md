# auth

Accounts for Flowwing and for anything else that wants to share them (bookreader does).

## The contract

A host mounts three endpoints. Callers are servers, not readers, so they authenticate with a shared
secret in `X-Flowwing-Service` rather than a session.

```
  POST /service/register   { username, password }  → 201 { userId, username, track }
  POST /service/login      { username, password }  → 200 { userId, username, track }
                                                     401 { error: "bad-credentials" }
                                                     409 { error: "taken" }
  POST /service/password   { username, passwordHash } → 200     (the Pi upgrading a hash it alone can verify)
```

## Mounting it

```ts
import { serviceAuthRoutes } from "@/src/lib/auth";

serviceAuthRoutes(app, { secret: process.env.SERVICE_SECRET ?? process.env.FLOWWING_IDENTITY_SECRET });
```

The host supplies the store through the app context (`c.get("store")`), so the same code runs on
`node:sqlite` and on D1.

## Rules that survived the move

- passwords are salted and hashed in the portable format; only a hash of the session token is stored
- usernames are unique, case-folded; there is deliberately no "same name, different person"
- a row may carry a legacy scrypt hash; it verifies on the Pi, is upgraded there, and sent back
  through `/service/password` — a Worker cannot verify it at all
