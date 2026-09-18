/** Server-sent events parser over a byte stream with a byte cap enforced while reading (§18.5). */
export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
}

export interface SSEOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

export class SSEByteLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`SSE stream exceeded ${maxBytes} bytes`);
    this.name = "SSEByteLimitError";
  }
}

export async function* parseSSE(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  opts: SSEOptions,
): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let total = 0;
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  const iterable: AsyncIterable<Uint8Array> =
    "getReader" in source ? readableToAsyncIterable(source as ReadableStream<Uint8Array>) : (source as AsyncIterable<Uint8Array>);

  const dispatch = function* (): Generator<SSEMessage> {
    if (data.length === 0 && event === undefined) {
      event = undefined;
      return;
    }
    const msg: SSEMessage = { data: data.join("\n") };
    if (event !== undefined) msg.event = event;
    if (id !== undefined) msg.id = id;
    event = undefined;
    data = [];
    yield msg;
  };

  for await (const chunk of iterable) {
    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException("aborted", "AbortError");
    total += chunk.byteLength;
    if (total > opts.maxBytes) throw new SSEByteLimitError(opts.maxBytes);
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r\n|\n|\r/)) !== -1) {
      // A lone CR at the very end may be the first half of a CRLF split across chunks: wait for more data.
      if (buffer[idx] === "\r" && idx === buffer.length - 1) break;
      const line = buffer.slice(0, idx);
      const sepLen = buffer.startsWith("\r\n", idx) ? 2 : 1;
      buffer = buffer.slice(idx + sepLen);
      if (line === "") {
        yield* dispatch();
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "event":
          event = value;
          break;
        case "data":
          data.push(value);
          break;
        case "id":
          id = value;
          break;
        default:
          break; // retry and unknown fields ignored
      }
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r\n|\n|\r/)) {
    if (line === "") {
      yield* dispatch();
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
  }
  yield* dispatch();
}

async function* readableToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
