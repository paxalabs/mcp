import { randomUUID } from "node:crypto";

export const TTS_MODEL = "paxa-tts-flash-v1";
export const TRANSLATE_MODEL = "paxa-translation-lite-v1";
export const OCR_MODEL = "paxa-ocr-lite-v1";

export const TTS_MAX_CHARS = 5000;
export const OCR_MAX_BYTES = 10 * 1024 * 1024;

const RETRYABLE_CODES = new Set([
  "rate_limited",
  "concurrency_limited",
  "provider_error",
  "provider_unavailable",
  "idempotency_in_flight",
  "internal",
]);

export class PaxaApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly requestId: string | undefined,
    detail?: string,
  ) {
    super(detail && detail.length > 0 ? detail : code);
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  display(): string {
    let out = `Paxa API error "${this.code}" (HTTP ${this.status})`;
    if (this.message !== this.code) out += `: ${this.message}`;
    if (this.requestId) out += ` [request id ${this.requestId}]`;
    if (this.retryable) out += ". This error is retryable.";
    return out;
  }
}

export type AudioFormat = "mp3" | "opus" | "wav";

export interface TtsRequest {
  text: string;
  voice: string;
  format?: AudioFormat;
  model?: string;
}

export interface Voice {
  id: string;
  name: string;
  gender: string | null;
  language: string | null;
  accent: string | null;
  description: string | null;
  model: string;
}

export interface PaxaModel {
  id: string;
  name: string;
  product: "tts" | "translation" | "ocr";
  max_chars: number | null;
  max_request_chars: number | null;
  credits_per_1k_chars: number | null;
  reference_credits_per_1k_chars: number | null;
  credits_per_page: number | null;
  max_pages: number | null;
  max_bytes: number | null;
  formats: string[] | null;
  min_request_credits: number | null;
  voices: string[];
  sources: string[] | null;
  target: string | null;
}

export interface TranslateRequest {
  text: string | string[];
  model?: string;
  source?: string;
  formality?: "auto" | "formal" | "casual";
  borrowed_words?: "auto" | "transliterate" | "preserve";
  format?: "text" | "markdown" | "html";
  instructions?: string;
  context?: string;
  do_not_translate?: string[];
  glossary?: Array<{ source: string; target: string }>;
}

export interface TranslateResponse {
  translations: Array<{
    text: string;
    detected_source?: string;
    review?: { reason: string; detail?: string } | null;
  }>;
  usage: {
    text_chars: number;
    reference_chars: number;
    billable_chars: number;
    credits: number;
  };
}

export interface OcrRequest {
  document: string;
  model?: string;
  output?: "markdown" | "structured";
}

export interface OcrResponse {
  pages: Array<{
    page: number;
    markdown?: string;
    blocks?: unknown[];
  }>;
  usage: { pages: number; credits: number };
}

export interface AccountInfo {
  key: {
    id: string;
    name: string | null;
    key_start: string;
    credit_limit: number | null;
    credits_spent: number;
    created_at: string;
    last_used_at: string | null;
  };
  balance: { wallet: number; plan: number; total: number };
  plan: { key: string; rpm: number; concurrency: number; monthly_credits: number };
}

export class PaxaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request(
    path: string,
    init: { method?: string; body?: unknown; idempotent?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotent) headers["idempotency-key"] = randomUUID();

    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach the Paxa API at ${this.baseUrl}: ${cause}`);
    }

    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? undefined;
      let code = "unknown";
      let detail: string | undefined;
      if ((res.headers.get("content-type") ?? "").includes("json")) {
        const body = (await res.json().catch(() => undefined)) as
          | { title?: string; detail?: string }
          | undefined;
        if (body?.title) code = body.title;
        detail = body?.detail;
      }
      throw new PaxaApiError(code, res.status, requestId, detail);
    }
    return res;
  }

  async tts(req: TtsRequest): Promise<Buffer> {
    const res = await this.request("/v1/tts", {
      method: "POST",
      body: { model: TTS_MODEL, format: "mp3", ...req, stream: false },
      idempotent: true,
      timeoutMs: 120_000,
    });
    return Buffer.from(await res.arrayBuffer());
  }

  async translate(req: TranslateRequest): Promise<TranslateResponse> {
    const res = await this.request("/v1/translate", {
      method: "POST",
      body: { model: TRANSLATE_MODEL, ...req },
      idempotent: true,
      timeoutMs: 300_000,
    });
    return (await res.json()) as TranslateResponse;
  }

  async ocr(req: OcrRequest): Promise<OcrResponse> {
    const res = await this.request("/v1/ocr", {
      method: "POST",
      body: { model: OCR_MODEL, ...req },
      idempotent: true,
      timeoutMs: 300_000,
    });
    return (await res.json()) as OcrResponse;
  }

  async voices(): Promise<Voice[]> {
    const res = await this.request("/v1/voices");
    return ((await res.json()) as { voices: Voice[] }).voices;
  }

  async models(): Promise<PaxaModel[]> {
    const res = await this.request("/v1/models");
    return ((await res.json()) as { models: PaxaModel[] }).models;
  }

  async me(): Promise<AccountInfo> {
    const res = await this.request("/v1/me");
    return (await res.json()) as AccountInfo;
  }
}
