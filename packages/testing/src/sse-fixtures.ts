/** Helpers to fake `fetch` with recorded SSE bodies (contract cassettes, §13.6). */
export interface CassetteResponse {
  status?: number;
  headers?: Record<string, string>;
  /** SSE lines (each "event:"/"data:" line) or a raw body string. */
  sse?: string[];
  body?: string;
  /** Chunk boundaries to exercise partial-frame parsing. */
  chunkSize?: number;
}

export function sseBody(events: Array<{ event?: string; data: unknown }>): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.event) lines.push(`event: ${e.event}`);
    lines.push(`data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}`);
    lines.push("");
  }
  return lines;
}

export function fakeFetch(responses: CassetteResponse[] | ((url: string, init: RequestInit) => CassetteResponse)): typeof fetch & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const r = typeof responses === "function" ? responses(url, init) : responses[Math.min(i++, responses.length - 1)]!;
    const text = r.body ?? (r.sse ? r.sse.join("\n") + "\n" : "");
    const bytes = new TextEncoder().encode(text);
    const chunk = r.chunkSize ?? bytes.length;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let off = 0; off < bytes.length; off += chunk) controller.enqueue(bytes.slice(off, off + chunk));
        controller.close();
      },
    });
    const headers = new Headers({ "content-type": r.sse ? "text/event-stream" : "application/json", ...(r.headers ?? {}) });
    return new Response(stream, { status: r.status ?? 200, headers });
  }) as typeof fetch & { calls: Array<{ url: string; init: RequestInit }> };
  fn.calls = calls;
  return fn;
}
