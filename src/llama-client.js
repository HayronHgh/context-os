export class LlamaClient {
  constructor(config) {
    this.baseUrl = config.llamaBaseUrl.replace(/\/$/, "");
    this.model = config.model;
    this.timeoutMs = config.requestTimeoutSeconds * 1000;
  }

  async request(route, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options.headers ?? {})
        },
        signal: controller.signal
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (!response.ok) {
        const detail = body?.error?.message ?? body?.error ?? body?.raw ?? response.statusText;
        throw new Error(`llama-server ${response.status}: ${detail}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    return this.request("/health", { method: "GET", timeoutMs: 5000 });
  }

  async models() {
    return this.request("/v1/models", { method: "GET", timeoutMs: 5000 });
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model ?? this.model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 4096,
      cache_prompt: true
    };
    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }
    if (options.responseFormat) body.response_format = options.responseFormat;
    const result = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const message = result?.choices?.[0]?.message;
    if (!message) throw new Error("llama-server returned no assistant message");
    return { message, usage: result.usage ?? null, raw: result };
  }
}
