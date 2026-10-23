/**
 * Run the same reader flow against both hosts and diff the answers.
 *
 * Manual testing keeps finding the same class of defect: a route exists on one host and 501s on the
 * other, or returns a payload with a different shape. This walks the flow the interface walks, records
 * the status and a fingerprint of each response, and prints where the two disagree.
 *
 * Differences that are *by design* — generation and the placement test need the vocabulary, which the
 * Worker deliberately lacks — are declared below and reported as expected. Anything else is a failure.
 *
 *   npm run parity
 *   npm run parity -- --a http://berry:3100 --b https://flowwing-api.penghaoxi030616.workers.dev
 */
import { loadEnv } from "./env";

interface Host {
  name: string;
  base: string;
  cookie: string | null;
}

interface Step {
  name: string;
  /** Declared differences are reported but do not fail the run. */
  byDesign?: string;
  run: (host: Host) => Promise<{ status: number; note: string }>;
}

const DEFAULT_A = "http://berry:3100";
const DEFAULT_B = "https://flowwing-api.penghaoxi030616.workers.dev";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function call(host: Host, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(`${host.base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(host.cookie ? { Cookie: host.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((value) => value.split(";")[0]).find((value) => value.includes("flowwing_session"));
  if (session) host.cookie = session;
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON: the fingerprint falls back to the text */
  }
  return { status: response.status, json, text };
}

function keys(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : Array.isArray(value) ? `[${value.length}]` : typeof value;
}

let paragraphId = "";

const STEPS: Step[] = [
  {
    name: "register",
    run: async (host) => {
      const name = `parity-${host.name}-${Date.now()}`;
      const r = await call(host, "POST", "/api/auth/register", { username: name, password: "pw" });
      return { status: r.status, note: keys(r.json) };
    },
  },
  { name: "auth/me", run: async (h) => { const r = await call(h, "GET", "/api/auth/me"); return { status: r.status, note: keys(r.json) }; } },
  { name: "me", run: async (h) => { const r = await call(h, "GET", "/api/me"); return { status: r.status, note: keys(r.json) }; } },
  { name: "me/track → zh-en", run: async (h) => { const r = await call(h, "PATCH", "/api/me/track", { track: "zh-en" }); return { status: r.status, note: keys(r.json) }; } },
  {
    name: "paragraphs (en)",
    run: async (h) => {
      const r = await call(h, "GET", "/api/paragraphs?targetLang=en&summary=1");
      const list = Array.isArray(r.json) ? r.json : [];
      paragraphId = (list[0] as { _id?: string })?._id ?? "";
      return { status: r.status, note: list.length > 0 ? "non-empty" : "empty" };
    },
  },
  {
    name: "read paragraph",
    byDesign: "the unknown band is the model prediction here until the Pi's next pull writes its own reading",
    run: async (h) => {
      if (!paragraphId) return { status: 0, note: "no passage to read" };
      const r = await call(h, "GET", `/api/paragraphs/${paragraphId}`);
      const data = r.json as Record<string, unknown> | null;
      if (!data) return { status: r.status, note: r.text.slice(0, 40) };
      const vocabulary = (data.vocabulary ?? {}) as Record<string, { gloss?: string | null }>;
      const first = Object.values(vocabulary)[0];
      const unknown = (data.unknown ?? {}) as { band?: string; source?: string };
      return {
        status: r.status,
        note: `${keys(data)} | ${Object.keys(vocabulary).length} words | gloss "${first?.gloss ?? "—"}" | band ${unknown.band ?? "—"}`,
      };
    },
  },
  {
    name: "mark a word (words/mark)",
    run: async (h) => {
      const r = await call(h, "POST", "/api/words/mark", { targetLang: "en", lemmaKey: "dog", surface: "dog", paragraphId, charStart: 0, charEnd: 3 });
      return { status: r.status, note: keys(r.json) };
    },
    byDesign: "the Pi's response carries the estimator's state and ability; this host's carries the mark",
  },
  {
    name: "marks/batch",
    run: async (h) => {
      const r = await call(h, "POST", "/api/marks/batch", { paragraphId });
      return { status: r.status, note: JSON.stringify(r.json).slice(0, 40) };
    },
  },
  { name: "star", run: async (h) => { const r = await call(h, "POST", `/api/paragraphs/${paragraphId}/star`, { starred: true }); return { status: r.status, note: keys(r.json) }; } },
  { name: "difficulty vote", run: async (h) => { const r = await call(h, "POST", `/api/paragraphs/${paragraphId}/difficulty`, { band: "hard" }); return { status: r.status, note: keys(r.json) }; } },
  {
    name: "generate",
    byDesign: "needs the vocabulary: the writer lives on the Pi",
    run: async (h) => { const r = await call(h, "POST", "/api/paragraphs/generate", {}); return { status: r.status, note: keys(r.json) }; },
  },
  {
    name: "placement start",
    byDesign: "needs the vocabulary to sample items",
    run: async (h) => { const r = await call(h, "GET", "/api/placement"); return { status: r.status, note: keys(r.json) }; },
  },
  {
    name: "events (mark)",
    byDesign: "the Pi records an event only; the Worker records the event and the mark, because it has no dictionary to resolve against",
    run: async (h) => {
      const r = await call(h, "POST", "/api/events", { targetLang: "en", type: "mark", paragraphId, lemmaKey: "dog", surface: "dog" });
      return { status: r.status, note: keys(r.json) };
    },
  },
  { name: "logout", run: async (h) => { const r = await call(h, "POST", "/api/auth/logout"); return { status: r.status, note: keys(r.json) }; } },
];

async function main(): Promise<void> {
  const env = loadEnv();
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;

  const a: Host = { name: "pi", base: arg("a", DEFAULT_A), cookie: null };
  const b: Host = { name: "worker", base: arg("b", DEFAULT_B), cookie: null };

  const rows: Array<{ step: string; a: string; b: string; verdict: string }> = [];
  let failures = 0;

  for (const step of STEPS) {
    const [ra, rb] = await Promise.all([step.run(a), step.run(b)]);
    const same = ra.status === rb.status && ra.note === rb.note;
    const verdict = same ? "same" : step.byDesign ? "by design" : "DIFFERS";
    if (!same && !step.byDesign) failures += 1;
    rows.push({
      step: step.name,
      a: `${ra.status} ${ra.note}`,
      b: `${rb.status} ${rb.note}`,
      verdict,
    });
  }

  const width = (label: string, min: number) => Math.max(min, ...rows.map((r) => String(r[label as keyof typeof r]).length));
  const wStep = width("step", 16), wA = width("a", 30), wB = width("b", 30);
  console.log(`\n  ${"step".padEnd(wStep)}  ${"pi".padEnd(wA)}  ${"worker".padEnd(wB)}  verdict`);
  console.log(`  ${"-".repeat(wStep)}  ${"-".repeat(wA)}  ${"-".repeat(wB)}  ${"-".repeat(9)}`);
  for (const row of rows) {
    const mark = row.verdict === "DIFFERS" ? "✗" : row.verdict === "by design" ? "·" : "·";
    console.log(`  ${row.step.padEnd(wStep)}  ${row.a.padEnd(wA)}  ${row.b.padEnd(wB)}  ${mark} ${row.verdict}`);
  }
  console.log(`\n  ${failures} unexplained difference${failures === 1 ? "" : "s"}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
