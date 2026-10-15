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
 * `reasoning_effort` is the knob the API accepts for "think less", and it is measurable: on a
 * one-sentence task this model spends ~209 reasoning tokens unset against ~109 at `low`. What it is
 * not is *low in absolute terms* — on the paragraph task it reasoned for the entire token budget and
 * returned no text at all, because reasoning tokens are counted against `max_tokens`. So the budget
 * has to cover thinking *and* writing, and an empty reply has to be reported as what it is rather
 * than as a formatting problem.
 */

import { describeSecret, loadEnv } from "../env";

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Ask for a JSON object; the provider does not validate it, the caller does. */
  json?: boolean;
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
  const reasoningEffort = env.DEEPSEEK_REASONING || "low";
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
        max_tokens: request.maxTokens ?? 8000,
        temperature: 1,
      };
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;
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
