/**
 * SoMaJo, asked over HTTP, for segmentation only.
 *
 * The sidecar (`tools/tokenize/server.py`) runs the German/English SoMaJo tokenisers and returns token
 * offsets. It deliberately does not lemmatise — that is the dictionary's job — so this returns
 * segmentation, and the existing pipeline resolves every token against the lexicon exactly as before.
 *
 * Every failure path returns `null`. A missing sidecar must degrade to the built-in tokeniser, never
 * break a generation run or a read.
 */
export interface SegmentToken {
  surface: string;
  start: number;
  end: number;
}

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
    const data = (await response.json()) as { tokens?: Array<{ text: string; start: number; end: number }> };
    if (!data.tokens) return null;
    return data.tokens.map((token) => ({ surface: token.text, start: token.start, end: token.end }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
