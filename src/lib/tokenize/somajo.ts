/**
 * SoMaJo and Simplemma, asked over HTTP: segments, and gives each token its citation form.
 *
 * The sidecar (`tools/tokenize/server.py`) runs the SoMaJo tokenisers and Simplemma, and returns token
 * offsets with lemmas. The tokeniser treats those lemmas as stated forms, so the dictionary's
 * `inflections` table becomes a fallback rather than the only source.
 *
 * Every failure path returns `null`. A missing sidecar must degrade to the built-in tokeniser, never
 * break a generation run or a read.
 */
import type { SegmentToken } from "./index";

const DEFAULT_PORT = 3110;

export async function somajoTokens(
  text: string,
  lang: "de" | "en",
  timeoutMs = 2000,
): Promise<SegmentToken[] | null> {
  const port = Number(process.env.FLOWWING_TOKENIZER_PORT ?? DEFAULT_PORT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      tokens?: Array<{ text: string; start: number; end: number; lemma?: string }>;
    };
    if (!data.tokens) return null;
    return data.tokens.map((token) => ({
      surface: token.text,
      start: token.start,
      end: token.end,
      lemma: token.lemma,
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
