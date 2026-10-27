/**
 * Walk one host the way the interface walks it, step by step.
 *
 * The parity harness compares two hosts against each other; this checks a single host against the flow
 * the *client* actually performs — including the calls that are easy to forget because they are
 * fire-and-forget (the arrival vote, the exposure batch, the lookup), which is where the Pi is broken
 * first and the Worker copies it.
 *
 *   npm run walk                  the Pi
 *   npm run walk -- --host <url>  anywhere
 */
import { loadEnv } from "./env";

interface Host {
  base: string;
  cookie: string | null;
}

interface Result {
  step: string;
  status: number;
  note: string;
  ok: boolean;
}

async function call(host: Host, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${host.base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(host.cookie ? { Cookie: host.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    if (raw.includes("flowwing_session")) host.cookie = raw.split(";")[0];
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* an empty body is fine for some steps */
  }
  return { status: response.status, json };
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const env = loadEnv();
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;

  const host: Host = { base: arg("host", "http://berry:3100").replace(/\/$/, ""), cookie: null };
  const results: Result[] = [];

  /** Steps the Worker answers 501 by design: both need the vocabulary, which it deliberately lacks. */
  const BY_DESIGN = new Set(["generate", "placement start"]);

  const expect = (step: string, status: number, note: string, limit = 299) =>
    results.push({
      step,
      status,
      note,
      ok: status > 0 && status <= limit ? true : status === 501 && BY_DESIGN.has(step),
    });

  // One fixture account, reused. Registering a fresh user per run left 141 dead accounts in the
  // database — the walk was writing test data into the product's tables and never clearing it up.
  const name = "walk-fixture";

  {
    const r = await call(host, "GET", "/api/auth/me");
    expect("auth gate asks", r.status, String((r.json as { signedIn?: boolean })?.signedIn));
  }
  {
    const r = await call(host, "POST", "/api/auth/register", { username: name, password: "pw" });
    if (r.status === 409) {
      const login = await call(host, "POST", "/api/auth/login", { username: name, password: "pw" });
      expect("register", login.status, String((login.json as { username?: string })?.username ?? ""));
    } else {
      expect("register", r.status, String((r.json as { username?: string })?.username ?? ""));
    }
  }
  {
    const r = await call(host, "GET", "/api/me");
    const me = r.json as { targetLang?: string; ability?: unknown[] } | null;
    expect("me", r.status, `${me?.targetLang ?? "?"} · ability ${me?.ability?.length ?? 0}`);
  }

  let paragraphId = "";
  let targetLang = "de";
  let spans: Array<{ kind: string; lemmaKey: string; start: number; end: number; surface: string }> = [];
  {
    const r = await call(host, "GET", `/api/paragraphs?targetLang=${targetLang}&summary=1`);
    const list = (Array.isArray(r.json) ? r.json : []) as Array<{ _id: string }>;
    paragraphId = list[0]?._id ?? "";
    expect("history list", r.status, `${list.length} passages`);
  }
  {
    const r = await call(host, "GET", `/api/paragraphs/${paragraphId}`);
    const data = r.json as { spans?: typeof spans; unknown?: { band?: string }; vocabulary?: Record<string, { gloss?: string }> } | null;
    spans = data?.spans ?? [];
    const firstWord = spans.find((span) => span.kind === "word");
    const gloss = firstWord ? data?.vocabulary?.[firstWord.lemmaKey]?.gloss : null;
    expect("open a passage", r.status, `${spans.length} spans · ${gloss ?? "no gloss"} · ${data?.unknown?.band ?? "?"}`);
  }
  {
    // The client votes on arrival, with no body: it is agreement, and it is the row that makes the
    // calibration table more than a list of disagreements.
    const r = await call(host, "POST", `/api/paragraphs/${paragraphId}/difficulty`, {});
    expect("arrival vote", r.status, String((r.json as { summary?: { band?: string } })?.summary?.band ?? "ok"));
  }
  {
    const words = spans.filter((span) => span.kind === "word").slice(0, 3);
    const r = await call(host, "POST", "/api/events", {
      type: "exposure",
      targetLang,
      paragraphId,
      sessionId: `walk-${Date.now()}`,
      items: words.map((span) => ({ lemmaKey: span.lemmaKey, surface: span.surface, charStart: span.start, charEnd: span.end })),
    });
    expect("exposure batch", r.status, `${words.length} words`);
  }
  const word = spans.find((span) => span.kind === "word");
  if (word) {
    const r = await call(host, "POST", "/api/words/mark", {
      targetLang,
      lemmaKey: word.lemmaKey,
      lemma: word.surface,
      surface: word.surface,
      paragraphId,
      charStart: word.start,
      charEnd: word.end,
      pos: "",
    });
    expect("mark a word", r.status, Object.keys((r.json ?? {}) as object).join(","));
  }
  {
    const r = await call(host, "POST", "/api/marks/batch", { paragraphId });
    const marks = (r.json ?? {}) as Record<string, string>;
    const keyed = word ? marks[`${word.start}`] : undefined;
    expect("marks by character start", r.status, `${JSON.stringify(marks).slice(0, 30)} → ${keyed ?? "MISSING"}`);
  }
  if (word) {
    const r = await call(host, "POST", "/api/words/ignore", {
      targetLang, lemmaKey: word.lemmaKey, surface: word.surface, paragraphId, charStart: word.start, charEnd: word.end,
    });
    expect("unmark (ignore)", r.status, Object.keys((r.json ?? {}) as object).join(","));
  }
  {
    const r = await call(host, "POST", `/api/paragraphs/${paragraphId}/star`, { starred: true });
    expect("star", r.status, String((r.json as { starred?: boolean })?.starred));
  }
  {
    const r = await call(host, "POST", "/api/events", { type: "lookup", targetLang, paragraphId, lemmaKey: word?.lemmaKey, paragraphId2: undefined });
    expect("lookup event", r.status, Object.keys((r.json ?? {}) as object).join(","));
  }

  // Generation is the long one, and on the Pi it is the path that must work first.
  {
    const r = await call(host, "POST", "/api/paragraphs/generate", {});
    const data = r.json as { title?: string; words?: number; error?: string } | null;
    expect("generate", r.status, data?.title ? `${data.title} (${data.words} words)` : (data?.error ?? ""));
  }
  {
    const r = await call(host, "POST", "/api/placement");
    const data = r.json as { items?: unknown[] } | null;
    expect("placement start", r.status, `${data?.items?.length ?? 0} items`);
  }
  {
    const r = await call(host, "PATCH", "/api/me/track", { track: "zh-en" });
    const me = r.json as { targetLang?: string; ability?: unknown[] } | null;
    expect("switch track", r.status, `${me?.targetLang ?? "?"} · ability ${me?.ability?.length ?? 0}`);
  }
  {
    const r = await call(host, "POST", "/api/auth/logout");
    expect("sign out", r.status, "ok");
  }

  const width = Math.max(...results.map((r) => r.step.length), 10);
  console.log(`\n  ${host.base}\n`);
  console.log(`  ${"step".padEnd(width)}  status  note`);
  console.log(`  ${"-".repeat(width)}  ------  ${"-".repeat(40)}`);
  for (const result of results) {
    console.log(`  ${result.step.padEnd(width)}  ${String(result.status).padStart(6)}  ${result.ok ? "·" : "✗"} ${result.note}`);
  }
  const broken = results.filter((r) => !r.ok);
  console.log(`\n  ${broken.length} broken step${broken.length === 1 ? "" : "s"}`);
  process.exitCode = broken.length === 0 ? 0 : 1;
}

void main();
