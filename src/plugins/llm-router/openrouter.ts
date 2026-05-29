/**
 * OpenRouter HTTP client — the breadth layer for the LLM router (#70).
 *
 * OpenRouter is OpenAI-compatible:
 *   - POST {base}/chat/completions  → chat completion
 *   - GET  {base}/models            → full model catalogue
 *
 * `fetch` is injectable so tests run without network. The API key is passed in
 * by the caller (sourced from `OPENROUTER_API_KEY` in the env), never read here.
 */

import { type ChatMessage, type OpenRouterModel, ProviderError } from "./types.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterDeps {
  apiKey: string;
  baseUrl: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  schema?: Record<string, unknown>;
  maxTokens?: number;
  providerHint?: string;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Whether a requested `response_format` was sent (D5). */
  schemaApplied: boolean;
}

/**
 * One chat completion against a specific model. Throws `ProviderError` (carrying
 * the HTTP status) on a non-2xx response so the router can decide to fall over.
 */
export async function chatCompletion(
  model: string,
  opts: ChatCompletionOptions,
  deps: OpenRouterDeps,
): Promise<ChatCompletionResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const wantSchema = !!opts.schema;

  let res = await postChat(model, opts, wantSchema, deps, fetchImpl);
  let schemaApplied = wantSchema;

  // Best-effort structured output (SPEC-DELTA D5). If a schema'd request is
  // rejected (400/422 — the model/provider doesn't support response_format),
  // retry ONCE without the schema and report schemaApplied:false, rather than
  // failing the whole call. A non-schema 400/422 (genuinely bad request) is not
  // retried here and surfaces below.
  if (wantSchema && !res.ok && (res.status === 400 || res.status === 422)) {
    res = await postChat(model, opts, false, deps, fetchImpl);
    schemaApplied = false;
  }

  if (!res.ok) {
    const detail = await safeText(res);
    throw new ProviderError(
      `OpenRouter ${res.status} for ${model}: ${detail.slice(0, 200)}`,
      res.status,
      model,
    );
  }

  const json = (await res.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  return {
    content,
    model: json.model ?? model,
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
    schemaApplied,
  };
}

/** POST one chat-completion request. `includeSchema` controls whether the
 *  `response_format` block is sent. Network failures become a retriable 503
 *  ProviderError; HTTP-status handling is left to the caller. */
async function postChat(
  model: string,
  opts: ChatCompletionOptions,
  includeSchema: boolean,
  deps: OpenRouterDeps,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const body: Record<string, unknown> = { model, messages: opts.messages };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.providerHint) body.provider = { order: [opts.providerHint] };
  if (includeSchema && opts.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "result", schema: opts.schema },
    };
  }
  try {
    return await fetchImpl(`${deps.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (DNS, connection) — treat as retriable (5xx-like).
    throw new ProviderError(
      `network error calling ${model}: ${err instanceof Error ? err.message : String(err)}`,
      503,
      model,
    );
  }
}

/**
 * Fetch the full model catalogue. Maps OpenRouter's string pricing (USD/token)
 * to numbers. Throws `ProviderError` on a non-2xx response.
 */
export async function listModels(deps: OpenRouterDeps): Promise<OpenRouterModel[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${deps.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${deps.apiKey}` },
    });
  } catch (err) {
    // Mirror chatCompletion: surface a network failure as a retriable ProviderError
    // rather than a raw TypeError, so callers can handle it uniformly.
    throw new ProviderError(
      `network error listing models: ${err instanceof Error ? err.message : String(err)}`,
      503,
      "(models)",
    );
  }
  if (!res.ok) {
    const detail = await safeText(res);
    throw new ProviderError(
      `OpenRouter ${res.status} listing models: ${detail.slice(0, 200)}`,
      res.status,
      "(models)",
    );
  }
  const json = (await res.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string | number; completion?: string | number };
    }>;
  };
  const out: OpenRouterModel[] = [];
  for (const m of json.data ?? []) {
    if (!m.id) continue;
    out.push({
      id: m.id,
      name: m.name ?? m.id,
      context_length: m.context_length ?? 0,
      pricing: {
        prompt: toNumber(m.pricing?.prompt),
        completion: toNumber(m.pricing?.completion),
      },
    });
  }
  return out;
}

function toNumber(v: string | number | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
