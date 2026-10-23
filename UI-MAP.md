# Every control, where it leads, and how you get back

Traced from `components/FlowwingApp.tsx`. `→` is a destination, `↩` is a way back.

## 1. Sign-in gate

Rendered whenever there is no session (`signedIn !== true`).

```
  Name / Password
  [ Sign in ]            → POST /api/auth/login        → reload → reader
  [ Create account ]     → POST /api/auth/register     → reload → reader
  ↩  nothing to go back to: this is the entry point
```

## 2. Reader — the live passage

```
  Flowwing (wordmark)    no action
  [ A ]  avatar          → account page              ↩ avatar again closes it
  word tap               → popover: meanings
      [ mark ]           → POST /api/words/mark      ↩ tap elsewhere
      [ ignore ]         → POST /api/words/ignore    ↩ tap elsewhere
  [ ☆ / ★ ]  star        → POST …/:id/star           ↩ tap again
  band select            → POST …/:id/difficulty     ↩ choose again
  [ Generate ]           → POST /api/paragraphs/generate
                           Pi: new passage            ↩ stays on the passage
                           Worker: 501 — needs the vocabulary it does not have
```

## 3. Account page (overlay)

```
  [ A ]  avatar          → closes the page           ↩ (this is the only close)
  TRACKS  English → German  +
      row opens a box → choosing a track             → closes the page, loads the track
  LEVEL  B2               static
  PLACEMENT  →           → placement test            ↩ see below
  HISTORY 47  +
      row opens a fixed 128px box → a title          → closes the page, opens that passage
  SIGN OUT  →            → POST /api/auth/logout     → reload → sign-in gate
```

## 4. Placement test (overlay)

```
  [ Next ]               → next item
  [ I know it / I don't ]→ POST /api/placement/answer
  [ Finish ]             → POST /api/placement/submit → result, then its own exit
  [ exit control ]       → back to the live passage   ↩
```

## 5. Reader — a stored passage (browsing)

```
  [ Return ]             → the live passage           ↩
  [ List ]               → account page, history box open
  avatar                 → account page
```

## Dead ends and broken paths, as they stand

| Control | Host | Behaviour |
|---|---|---|
| Generate | Worker | 501 — the writer has no vocabulary there. The pool fills passages instead, so the button is the only way this shows. |
| Placement | Worker | 501 — same reason. |
| `words/ignore` | Worker | implemented now, but only against a packed passage. |
| History drawer | both | the old mobile drawer (`historyOpen`) is unreachable dead code. |
