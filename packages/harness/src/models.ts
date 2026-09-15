/**
 * Model access through any OpenAI-compatible chat-completions endpoint. OpenRouter
 * covers most labs with one key; OpenAI/Together/Groq/local vLLM work the same way.
 *
 * Env: SEALED_API_BASE (default https://openrouter.ai/api/v1), SEALED_API_KEY
 *      (falls back to OPENROUTER_API_KEY, then OPENAI_API_KEY).
 */
import { harnessHash } from "./hash.js";

export const HARNESS_VERSION = "sealed-harness/1";

export const SYSTEM_PROMPT =
  "You are being evaluated on exact-answer tasks. Work through the problem carefully; you may write out " +
  "intermediate steps. Your reply MUST end with one final line of the form\n" +
  "ANSWER: <answer>\n" +
  "where <answer> is only the answer itself: no units, no explanation, no punctuation after it.";

export interface HarnessConfig {
  version: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  version: HARNESS_VERSION,
  systemPrompt: SYSTEM_PROMPT,
  temperature: 0,
  maxTokens: 4096,
};

export function configHash(cfg: HarnessConfig = DEFAULT_CONFIG): Uint8Array {
  return harnessHash({ ...cfg });
}

export interface ModelClientOptions {
  apiBase?: string;
  apiKey?: string;
  concurrency?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export interface Completion {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  latencyMs: number;
}

export class ModelClient {
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ModelClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? process.env.SEALED_API_BASE ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.SEALED_API_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.concurrency = opts.concurrency ?? 6;
    this.retries = opts.retries ?? 4;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (!this.apiKey) throw new Error("no API key: set SEALED_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY)");
  }

  async complete(model: string, prompt: string, cfg: HarnessConfig = DEFAULT_CONFIG): Promise<Completion> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const t0 = Date.now();
      try {
        const res = await this.fetchImpl(`${this.apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
            "x-title": "sealed-harness",
          },
          body: JSON.stringify({
            model,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            messages: [
              { role: "system", content: cfg.systemPrompt },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        if (!res.ok) throw new FatalHttpError(`HTTP ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
          usage?: Completion["usage"];
        };
        const content = json.choices?.[0]?.message?.content;
        const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : (content ?? "");
        return { text, usage: json.usage, latencyMs: Date.now() - t0 };
      } catch (e) {
        if (e instanceof FatalHttpError) throw e;
        lastErr = e;
        await sleep(500 * 2 ** attempt + Math.random() * 250);
      }
    }
    throw new Error(`model call failed after ${this.retries + 1} attempts: ${String(lastErr)}`);
  }

  /** Run `prompts` through `model` with bounded concurrency, preserving order. */
  async completeAll(
    model: string,
    prompts: string[],
    cfg: HarnessConfig = DEFAULT_CONFIG,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Completion[]> {
    const out: Completion[] = new Array(prompts.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= prompts.length) return;
        out[i] = await this.complete(model, prompts[i], cfg);
        onProgress?.(++done, prompts.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, prompts.length) }, worker));
    return out;
  }
}

export class FatalHttpError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
