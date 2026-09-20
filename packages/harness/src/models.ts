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
  /** Per-request timeout; a stalled gateway connection would otherwise hang a run forever. */
  timeoutMs?: number;
  /** Stable session id sent as x-opencode-session (Zen free tier requires it). */
  sessionId?: string;
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
  private readonly timeoutMs: number;
  private readonly sessionId: string;

  constructor(opts: ModelClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? process.env.SEALED_API_BASE ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.SEALED_API_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.concurrency = opts.concurrency ?? 6;
    this.retries = opts.retries ?? 4;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.sessionId = opts.sessionId ?? process.env.SEALED_SESSION_ID ?? `sealed-${Date.now().toString(36)}`;
    if (!this.apiKey) throw new Error("no API key: set SEALED_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY)");
  }

  async complete(model: string, prompt: string, cfg: HarnessConfig = DEFAULT_CONFIG): Promise<Completion> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const t0 = Date.now();
      try {
        const res = await this.fetchImpl(`${this.apiBase}/chat/completions`, {
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
            "x-title": "sealed-harness",
            // OpenCode Zen routes/caches by a per-session id; required for its free tier.
            "x-opencode-session": this.sessionId,
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
        if (res.status === 429) throw new RateLimitError(`HTTP 429: ${await res.text()}`);
        if (res.status >= 500) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        if (!res.ok) throw new FatalHttpError(`HTTP ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
          error?: { message?: string };
          usage?: Completion["usage"];
        };
        if (json.error?.message) throw new FatalHttpError(`HTTP 200 error payload: ${json.error.message}`);
        const content = json.choices?.[0]?.message?.content;
        const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : (content ?? "");
        // Free gateways increasingly return credit/quota walls as a 200 with the
        // notice rendered as assistant content. Treat as an endpoint error — a
        // retryable RateLimitError — never as a model answer (run.ts also refuses
        // an artifact when one reply dominates the whole bank).
        const head = text.slice(0, 300).toLowerCase();
        if (!text.trim()) throw new Error("empty completion content");
        if (PROVIDER_ERROR_SIGS.some((sig) => head.includes(sig)))
          throw new RateLimitError(`provider notice as content: ${text.slice(0, 120)}`);
        return { text, usage: json.usage, latencyMs: Date.now() - t0 };
      } catch (e) {
        if (e instanceof FatalHttpError) throw e;
        lastErr = e;
        // Free-tier gateways (e.g. Zen) rate-limit per ~minute window; 429 needs a long wait.
        const base = e instanceof RateLimitError ? 15_000 : 500;
        const mult = e instanceof RateLimitError ? attempt + 1 : 2 ** attempt;
        await sleep(base * mult + Math.random() * 250);
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
export class RateLimitError extends Error {}

/** Substrings (lowercased) that mean "endpoint notice", never a model answer. */
const PROVIDER_ERROR_SIGS = [
  "doesn't have enough credits",
  "does not have enough credits",
  "no payment method",
  "creditserror",
  "insufficient_quota",
  "insufficient credits",
  "exceeded your current quota",
  "payment required",
  "add a payment method",
  "upgrade your plan",
  "free tier limit",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Offline stand-in for demos and smoke tests: `mock/oracle-0.6` answers 60% of items
 * correctly (deterministically per prompt) with deliberately sloppy formatting, the
 * rest wrong. Needs the bank to look up reference answers, so it is constructed by
 * the run pipeline, never by end users.
 */
export class MockModelClient extends ModelClient {
  constructor(private readonly answers: Map<string, string>) {
    super({ apiKey: "mock", fetchImpl: (async () => new Response("unused")) as typeof fetch });
  }

  static isMock(model: string) {
    return model.startsWith("mock/");
  }

  async complete(model: string, prompt: string): Promise<Completion> {
    const m = /^mock\/oracle-(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(model);
    if (!m) throw new Error(`unknown mock model ${model}; use mock/oracle-<p> with p in [0,1]`);
    const p = Number(m[1]);
    const ref = this.answers.get(prompt);
    if (ref === undefined) throw new Error("mock model asked a prompt that is not in the bank");
    // Deterministic coin per prompt so re-runs reproduce the same score.
    let h = 2166136261;
    for (const ch of prompt) h = (h ^ ch.charCodeAt(0)) * 16777619 >>> 0;
    const correct = (h % 10_000) / 10_000 < p;
    const text = correct
      ? `Let me work through this.\n\n**ANSWER:**  ${ref.toUpperCase()} .`
      : `I think it is\nANSWER: ${ref}x`;
    return { text, latencyMs: 0 };
  }
}
