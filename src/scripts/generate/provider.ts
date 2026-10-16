/**
 * The LLM provider seam.
 *
 * One interface, so the generator does not care who writes the text. DeepSeek is the configured
 * implementation; a different provider is a different object with the same method.
 *
 * The model and its thinking level are read from `.env.local` rather than hard-coded, because both
 * are account-specific — this account offers `deepseek-flash` and `deepseek-v4-pro`, and neither is
 * the `deepseek-chat` this would otherwise have assumed.
 *
 * ## Thinking is off, and that is a documented setting, not a guess
 *
 * The API accepts `reasoning_effort` of `none | low | high | max`, where **`none` disables thinking**
 * and the others enable it, `high` by default. An earlier version of this file set `low`, intending
 * "think a little" — which enabled thinking, and every call generated thousands of reasoning tokens
 * against a `max_tokens` of 8000. That was the whole of an 80-second latency, and it sometimes spent
 * the entire budget thinking and returned no text at all.
 *
 * Writing a hundred-word passage is composition, not reasoning. The output is checked by the rubric
 * and the coherence judge, which is a better use of the tokens than asking the model to deliberate.
 * `max_tokens` is bounded to match: in thinking mode the API defaults to 64K, which is exactly what
 * lets one call run for minutes.
 */

import { describeSecret, loadEnv } from "../env";

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Ask for a JSON object; the provider does not validate it, the caller does. */
  json?: boolean;
  /**
   * Sampling temperature. Defaults to 1, which is right for writing and wrong for judging: a judge
   * that answers differently each time makes acceptance a coin flip for borderline text, and one
   * paragraph that had been accepted was rejected on re-judging.
   */
  temperature?: number;
  /**
   * Override the thinking budget for this call. `"none"` measurably produces zero reasoning tokens on
   * this model, which for a hundred-word passage is the difference between seconds and minutes.
   */
  reasoningEffort?: string;
}

export interface Completion {
  text: string;
  /** Reasoning tokens, when the model reports them; useful for watching cost. */
  reasoningTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

export function deepseekProvider(env: Record<string, string> = loadEnv()): Provider {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      "DEEPSEEK_API_KEY is not configured. Put it in app/.env.local (gitignored); see src/scripts/env.ts.",
    );
  }

  const model = env.DEEPSEEK_MODEL || "deepseek-flash";
  const reasoningEffort = env.DEEPSEEK_REASONING || "none";
  const baseUrl = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  return {
    name: "deepseek",
    model,

    async complete(request) {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        max_tokens: request.maxTokens ?? Number(env.DEEPSEEK_MAX_TOKENS || 1200),
        temperature: request.temperature ?? 1,
      };
      const effort = request.reasoningEffort ?? reasoningEffort;
      if (effort && effort !== "default") body.reasoning_effort = effort;
      if (request.json) body.response_format = { type: "json_object" };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await res.json().catch(() => null)) as ChatResponse | null;
      if (!res.ok) {
        // The provider's message is safe to surface; the request that produced it is not.
        throw new ProviderError(
          `deepseek ${res.status}: ${payload?.error?.message?.slice(0, 300) ?? "no body"}`,
          res.status,
        );
      }

      const text = payload?.choices?.[0]?.message?.content ?? "";
      return {
        text,
        reasoningTokens: payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        promptTokens: payload?.usage?.prompt_tokens ?? 0,
        completionTokens: payload?.usage?.completion_tokens ?? 0,
      };
    },
  };
}

/** What the generator logs about its provider: never the key. */
export function describeProvider(provider: Provider, env = loadEnv()): string {
  return [
    `  provider     ${provider.name} · ${provider.model} · reasoning_effort=${env.DEEPSEEK_REASONING || "low"}`,
    `  credential   ${describeSecret("DEEPSEEK_API_KEY", env.DEEPSEEK_API_KEY)}`,
  ].join("\n");
}
