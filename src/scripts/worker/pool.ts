/**
 * The orchestrator: keep D1's pool as deep as the Pi's own.
 *
 * The Pi already has a pool — `paragraphs.buffered`, `pool_reads`, retired after three readers, refilled
 * when a claim leaves it shallow. Its frontend reads from it and gets a passage instantly.
 *
 * D1 is the same shape, and this loop is what makes it behave the same way: it measures D1's depth per
 * language and level, and while that is below the Pi's own target it moves a passage across — an unread
 * one from the Pi's pool first, and only if the Pi has none does it write a new one with the Pi's
 * existing pipeline. Nothing new is invented here: the depth target, the claim rule and the retirement
 * rule are the Pi's, applied to the other database.
 */
import { all, get, nowMs, run } from "../../lib/store/db";
import { packageFor } from "../../lib/content/pack";
import { markBufferedByBrief } from "../../lib/store/content";
import type { CefrLevel, TargetLang } from "../../lib/lang";
import { generateOne, importParagraph } from "../generate/generate";
import { deepseekProvider } from "../generate/provider";
import { BRIEFS, briefIdOf } from "../generate/briefs";
import { pickTopic } from "../generate/topics";
import { callService, serviceConfig, type ServiceConfig } from "./client";

/** The Pi's own target, used for both pools so they cannot disagree. */
export const POOL_TARGET = 3;

const LEVELS: Array<[TargetLang, CefrLevel]> = [
  ["de", "A2"], ["de", "B1"], ["de", "B2"],
  ["en", "A2"], ["en", "B1"], ["en", "B2"],
];

/** Passages already sent to D1, so the loop does not push the same one twice. */
const MIRRORED = "d1_mirror";

function ensureMirrorTable(): void {
  run(`CREATE TABLE IF NOT EXISTS ${MIRRORED} (paragraphId TEXT PRIMARY KEY, pushedAt INTEGER NOT NULL)`);
}

function mirrored(): Set<string> {
  return new Set(all<{ paragraphId: string }>(`SELECT paragraphId FROM ${MIRRORED}`).map((row) => row.paragraphId));
}

/** An unread passage from the Pi's pool, not yet sent anywhere. */
function takeFromLocalPool(targetLang: TargetLang, level: CefrLevel, sent: Set<string>): string | null {
  const rows = all<{ id: string }>(
    `SELECT p.id FROM paragraphs p
      WHERE p.targetLang = ? AND p.level = ? AND p.buffered = 1
        AND (SELECT COUNT(*) FROM pool_reads r WHERE r.paragraphId = p.id) < 3
      ORDER BY p.createdAt ASC`,
    targetLang,
    level,
  );
  return rows.find((row) => !sent.has(row.id))?.id ?? null;
}

/** Write one with the Pi's own pipeline, and put it in the Pi's pool. */
async function writeForPool(targetLang: TargetLang, level: CefrLevel): Promise<string | null> {
  const brief = BRIEFS.find((entry) => entry.targetLang === targetLang && entry.level === level);
  if (!brief) return null;
  const used = all<{ topic: string }>(
    "SELECT DISTINCT topic FROM paragraphs WHERE targetLang = ? AND level = ? AND topic IS NOT NULL",
    targetLang,
    level,
  ).map((row) => row.topic);
  const topic = pickTopic(targetLang, level, used) || brief.topic;
  const spec = { ...brief, topic, briefId: `${briefIdOf(brief)}:${Date.now()}` };
  const outcome = await generateOne(deepseekProvider(), spec);
  if (!outcome.passed || !outcome.content) {
    console.warn(`  pool: ${targetLang}/${level} not accepted — ${outcome.issues.slice(0, 1).join("") || "no content"}`);
    return null;
  }
  const id = await importParagraph(outcome);
  // `importParagraph` stores it as a live passage; it is stock, so it joins the pool it was written for.
  markBufferedByBrief(targetLang, spec.briefId);
  return id;
}

/** Push one passage and its package to D1, marked as stock. */
async function push(config: ServiceConfig, paragraphId: string): Promise<boolean> {
  const pack = packageFor(paragraphId);
  const paragraph = get<Record<string, unknown>>("SELECT * FROM paragraphs WHERE id = ?", paragraphId);
  if (!pack || !paragraph) return false;
  await callService(config, "/passages", {
    method: "POST",
    body: JSON.stringify({ paragraph: { ...paragraph, buffered: 1 }, package: pack }),
  });
  run(`INSERT OR REPLACE INTO ${MIRRORED} (paragraphId, pushedAt) VALUES (?,?)`, paragraphId, nowMs());
  return true;
}

export async function syncD1Pool(): Promise<{ pushed: number; depth: Record<string, number> }> {
  const config = serviceConfig();
  ensureMirrorTable();
  const sent = mirrored();

  const remote = await callService<{ depth: Array<{ targetLang: string; level: string | null; depth: number }> }>(
    config,
    "/pool",
  );
  const depth = new Map<string, number>();
  for (const row of remote.depth) depth.set(`${row.targetLang}:${row.level}`, row.depth);

  let pushed = 0;
  const summary: Record<string, number> = {};
  for (const [targetLang, level] of LEVELS) {
    const key = `${targetLang}:${level}`;
    let have = depth.get(key) ?? 0;
    summary[key] = have;
    while (have < POOL_TARGET) {
      // The Pi's pool first; only when it holds nothing unread does this write a new passage.
      let candidate = takeFromLocalPool(targetLang, level, sent);
      if (!candidate) candidate = await writeForPool(targetLang, level);
      if (!candidate) break;
      if (!(await push(config, candidate))) break;
      sent.add(candidate);
      have += 1;
      pushed += 1;
      summary[key] = have;
    }
  }
  return { pushed, depth: summary };
}
