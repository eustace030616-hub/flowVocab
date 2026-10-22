/**
 * Pack a passage: tokenise it and gloss it once, then store the result with it.
 *
 * This is the writer's job because the writer is where the dictionary is. The reader then needs one
 * row plus that reader's own marks — no tokeniser, no dictionary, no six queries per view. It is also
 * what lets the frontend be served from a host that has never seen the 840k-row vocabulary.
 *
 * A package is a *snapshot*. When the dictionary or the tokeniser changes, `version` no longer matches
 * and the writer rebuilds it; the read path never repairs anything.
 */
import { wordsByKeys } from "../store/dictionary";
import { glossesByLemma } from "../learner/glosses";
import { tokenizeWithLexicon } from "../learner/lexicon";
import { wordSpans } from "../tokenize";
import { get, nowMs, run } from "../store/db";
import type { TargetLang } from "../lang";

/** Bump when the shape or the pipeline changes, so old packages are rebuilt. */
export const PACKAGE_VERSION = 1;

export interface PackageVocabulary {
  lemma: string;
  pos: string | null;
  gloss: string | null;
  glossGenerated: boolean | null;
  glossSource: string | null;
  glossTermPos: string | null;
  glossPos: string | null;
  /** From the word row: the reader's probability of knowing it is a function of this and their θ. */
  difficulty: number;
  meanings: Array<{ pos: string | null; termPos: string | null; text: string; source: string | null }>;
}

export interface PassagePackage {
  version: number;
  spans: Array<Record<string, unknown>>;
  vocabulary: Record<string, PackageVocabulary>;
}

export async function packParagraph(paragraphId: string): Promise<PackageVocabulary[] | null> {
  const row = get<{ content: string; targetLang: string }>(
    "SELECT content, targetLang FROM paragraphs WHERE id = ?",
    paragraphId,
  );
  if (!row) return null;

  const targetLang = row.targetLang as TargetLang;
  const spans = await tokenizeWithLexicon(row.content, targetLang);
  const keys = [...new Set(wordSpans(spans).map((span) => span.lemmaKey))];

  const words = keys.length ? await wordsByKeys(targetLang, keys, { origin: null }) : [];
  const glosses = await glossesByLemma(targetLang, "en", keys);

  const vocabulary: Record<string, PackageVocabulary> = {};
  for (const word of words) {
    if (vocabulary[word.lemmaKey]) continue;
    const meanings = glosses.get(word.lemmaKey) ?? [];
    const best = meanings.find((m) => m.pos && m.pos === word.pos) ?? meanings[0] ?? null;
    vocabulary[word.lemmaKey] = {
      lemma: word.lemma,
      pos: word.pos ?? null,
      gloss: best?.text ?? null,
      glossGenerated: best?.generated ?? null,
      glossSource: best?.source ?? null,
      glossTermPos: best?.termPos ?? null,
      glossPos: best?.pos ?? null,
      difficulty: word.difficulty,
      meanings: meanings.map((m) => ({
        pos: m.pos || null,
        termPos: m.termPos ?? null,
        text: m.text,
        source: m.source ?? null,
      })),
    };
  }

  const data: PassagePackage = { version: PACKAGE_VERSION, spans: spans as unknown as Array<Record<string, unknown>>, vocabulary };
  run(
    `INSERT INTO passage_packages (paragraphId, version, data, createdAt) VALUES (?,?,?,?)
     ON CONFLICT(paragraphId) DO UPDATE SET version = excluded.version, data = excluded.data, createdAt = excluded.createdAt`,
    paragraphId,
    PACKAGE_VERSION,
    JSON.stringify(data),
    nowMs(),
  );
  return Object.values(vocabulary);
}

/** The stored package, or `null` when the passage has never been packed at this version. */
export function packageFor(paragraphId: string): PassagePackage | null {
  const row = get<{ version: number; data: string }>(
    "SELECT version, data FROM passage_packages WHERE paragraphId = ?",
    paragraphId,
  );
  if (!row || row.version !== PACKAGE_VERSION) return null;
  try {
    return JSON.parse(row.data) as PassagePackage;
  } catch {
    return null;
  }
}
