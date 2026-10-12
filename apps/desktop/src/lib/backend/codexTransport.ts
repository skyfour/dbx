type Packet = { type?: string; id?: string; data?: string; text?: string | boolean; status?: number; headers?: Record<string, string>; message?: string; code?: number; reason?: string; path?: string; end?: boolean; textMessage?: boolean };
type Command = { action: string; id?: string; path?: string; method?: string; body?: boolean; headers?: Record<string, string>; data?: string; text?: string | boolean; end?: boolean; name?: string };
export type CodexCall = (command: Command) => Promise<Packet>;
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const decode = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const aborted = () => new DOMException("The operation was aborted", "AbortError");

export function createCodexFetch(call: CodexCall): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://dbx.invalid");
    if (url.origin !== "https://dbx.invalid" || !url.pathname.startsWith("/api/")) throw new Error("Only local DBX API requests are supported");
    const request = new Request(url, input instanceof Request ? new Request(input, init) : init);
    if (request.signal.aborted) throw aborted();
    let id: string | undefined,
      closed = false,
      controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = () => {
      if (closed || !id) return;
      closed = true;
      void call({ action: "close", id }).catch(() => {});
    };
    const onAbort = () => {
      close();
      controller?.error(aborted());
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => request.signal.removeEventListener("abort", onAbort);
    try {
      const opened = await call({ action: "open", path: url.pathname + url.search, method: request.method, headers: Object.fromEntries(request.headers), body: request.body !== null });
      id = opened.id;
      if (!id) throw new Error("DBX did not open a request stream");
      if (request.signal.aborted) {
        close();
        throw aborted();
      }
      if (request.body) {
        const reader = request.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            for (let offset = 0; offset < chunk.value.length; offset += 65536) {
              if (request.signal.aborted) throw aborted();
              await call({ action: "write", id, data: encode(chunk.value.subarray(offset, offset + 65536)) });
            }
          }
          await call({ action: "write", id, end: true });
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      const read = async () => {
        while (true) {
          if (request.signal.aborted) throw aborted();
          const packet = await call({ action: "read", id });
          if (packet.type !== "pending") return packet;
        }
      };
      const headers = await read();
      if (headers.type !== "headers") throw new Error(headers.message ?? "DBX did not return response headers");
      const stream = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
            if (request.signal.aborted) c.error(aborted());
          },
          async pull(c) {
            try {
              const packet = await read();
              if (packet.type === "data") c.enqueue(decode(packet.data!));
              else if (packet.type === "end") {
                closed = true;
                cleanup();
                c.close();
              } else throw new Error(packet.message ?? "DBX stream failed; request was not retried");
            } catch (error) {
              close();
              cleanup();
              c.error(error);
            }
          },
          cancel() {
            close();
            cleanup();
          },
        },
        { highWaterMark: 0 },
      );
      const empty = request.method === "HEAD" || [204, 205, 304].includes(headers.status!);
      if (empty) {
        await stream.cancel();
      }
      return new Response(empty ? null : stream, { status: headers.status, headers: headers.headers });
    } catch (error) {
      close();
      cleanup();
      throw error;
    }
  };
}

export async function saveCodexDownload(call: CodexCall, response: Response, name: string): Promise<string> {
  let id: string | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!response.ok || !response.body) throw new Error("DBX export failed");
    id = (await call({ action: "export_open", name })).id;
    if (!id) throw new Error("DBX did not open an export");
    reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (let offset = 0; offset < chunk.value.length; offset += 65536) await call({ action: "export_write", id, data: encode(chunk.value.subarray(offset, offset + 65536)) });
    }
    const result = await call({ action: "export_write", id, end: true });
    if (!result.path) throw new Error("DBX export path missing");
    return result.path;
  } catch (error) {
    await (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {});
    if (id) await call({ action: "close", id }).catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
function installDownloads(call: CodexCall) {
  const download = (anchor: HTMLAnchorElement) => {
    const href = anchor.getAttribute("href");
    if (!href) return false;
    if (!anchor.hasAttribute("download") && !href.startsWith("/api/")) return false;
    void (async () => {
      const response = await globalThis.fetch(href);
      const disposition = response.headers.get("content-disposition") ?? "";
      let encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      if (encoded) {
        try {
          encoded = decodeURIComponent(encoded);
        } catch {
          /* Keep a malformed filename as text. */
        }
      }
      const name = anchor.download || (encoded ? encoded : disposition.match(/filename="?([^";]+)/i)?.[1]) || "dbx-export.bin";
      const path = await saveCodexDownload(call, response, name);
      return "DBX: " + path;
    })()
      .catch((error) => "DBX: " + error.message)
      .then((message) => {
        const status = document.createElement("div");
        status.setAttribute("role", "status");
        status.textContent = message;
        status.className = "bg-background text-foreground border border-border rounded-lg shadow-xl";
        status.style.cssText = "position:fixed;bottom:20px;left:20px;right:20px;z-index:2147483647;padding:16px;overflow-wrap:anywhere";
        document.body.append(status);
        setTimeout(() => status.remove(), 15000);
      });
    return true;
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!download(this)) click.call(this);
  };
  document.addEventListener(
    "click",
    (event) => {
      const target = (event.target as Element)?.closest?.("a");
      if (target && download(target as HTMLAnchorElement)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}

export async function parseEventStream(stream: ReadableStream<Uint8Array>, receive: (event: { type: string; data: string; lastEventId: string }) => void) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    data: string[] = [],
    type = "message",
    lastEventId = "";
  const line = (line: string) => {
    if (line === "") {
      if (data.length) receive({ type, data: data.join("\n"), lastEventId });
      data = [];
      type = "message";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":"),
      name = colon < 0 ? line : line.slice(0, colon),
      value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "data") data.push(value);
    else if (name === "event") type = value || "message";
    else if (name === "id" && !value.includes("\0")) lastEventId = value;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, end).replace(/\r$/, ""));
        pending = pending.slice(end + 1);
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function installEventSource(fetch: typeof globalThis.fetch) {
  class Source extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly withCredentials = false;
    readonly url: string;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private abort = new AbortController();
    private lastEventId = "";
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      void this.connect();
    }
    private dispatch(event: Event) {
      this.dispatchEvent(event);
      if (event.type === "open") this.onopen?.(event);
      if (event.type === "error") this.onerror?.(event);
      if (event.type === "message") this.onmessage?.(event as MessageEvent);
    }
    private async connect() {
      while (this.readyState !== 2) {
        try {
          const response = await fetch(this.url, { headers: { Accept: "text/event-stream", ...(this.lastEventId ? { "Last-Event-ID": this.lastEventId } : {}) }, signal: this.abort.signal });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error("DBX event stream unavailable");
          }
          this.readyState = 1;
          this.dispatch(new Event("open"));
          await parseEventStream(response.body, (event) => {
            this.lastEventId = event.lastEventId;
            this.dispatch(new MessageEvent(event.type, { data: event.data, lastEventId: event.lastEventId }));
          });
        } catch {
          if (this.abort.signal.aborted) return;
        }
        if (this.abort.signal.aborted) return;
        this.readyState = 0;
        this.dispatch(new Event("error"));
        // EventSource reconnects only GET streams, never database writes.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.abort.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 3000);
          this.abort.signal.addEventListener("abort", done, { once: true });
        });
      }
    }
    close() {
      this.readyState = 2;
      this.abort.abort();
    }
  }
  globalThis.EventSource = Source as unknown as typeof EventSource;
}

function installWebSocket(call: CodexCall) {
  class Socket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    readyState = 0;
    bufferedAmount = 0;
    binaryType: BinaryType = "blob";
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private id?: string;
    private writes = Promise.resolve();
    private chunks: Uint8Array[] = [];
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      void this.connect();
    }
    private dispatch(event: Event) {
      this.dispatchEvent(event);
      if (event.type === "open") this.onopen?.(event);
      if (event.type === "error") this.onerror?.(event);
      if (event.type === "close") this.onclose?.(event as CloseEvent);
      if (event.type === "message") this.onmessage?.(event as MessageEvent);
    }
    private async connect() {
      try {
        const url = new URL(this.url, "ws://dbx.invalid");
        if (url.hostname !== "dbx.invalid" && url.host !== globalThis.location?.host) throw new Error("Foreign WebSocket target");
        this.id = (await call({ action: "socket_open", path: url.pathname + url.search })).id!;
        if (this.readyState === 2) {
          await call({ action: "close", id: this.id });
          this.readyState = 3;
          return;
        }
        while (this.readyState < 2) {
          const packet = await call({ action: "read", id: this.id });
          if (packet.type === "open") {
            this.readyState = 1;
            this.dispatch(new Event("open"));
          } else if (packet.type === "socket_data") {
            this.chunks.push(decode(packet.data!));
            if (packet.end) {
              const blob = new Blob(this.chunks as BlobPart[]);
              this.chunks = [];
              const data = packet.text ? await blob.text() : this.binaryType === "arraybuffer" ? await blob.arrayBuffer() : blob;
              this.dispatch(new MessageEvent("message", { data }));
            }
          } else if (packet.type === "close") {
            this.readyState = 3;
            this.dispatch(new CloseEvent("close", { code: packet.code, reason: packet.reason, wasClean: packet.code === 1000 }));
            return;
          } else if (packet.type === "error") throw new Error(packet.message);
        }
      } catch {
        if (this.readyState < 2) {
          this.readyState = 3;
          this.dispatch(new Event("error"));
          this.dispatch(new CloseEvent("close", { code: 1006 }));
        }
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState !== 1) throw new DOMException("DBX WebSocket is not open", "InvalidStateError");
      this.writes = this.writes
        .then(async () => {
          const text = typeof data === "string";
          const bytes = text ? new TextEncoder().encode(data as string) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
          for (let offset = 0; offset < bytes.length || offset === 0; offset += 65536) await call({ action: "socket_send", id: this.id, text, data: encode(bytes.subarray(offset, offset + 65536)), end: offset + 65536 >= bytes.length });
        })
        .catch(() => {
          this.dispatch(new Event("error"));
          this.close();
        });
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      void this.writes.finally(async () => {
        if (this.id) await call({ action: "close", id: this.id });
        this.readyState = 3;
        this.dispatch(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
      });
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
}

export async function installCodexTransport(version: string) {
  let nextId = 0;
  let dispose: (() => Promise<unknown>) | undefined;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++nextId);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex UI request timed out; it was not retried"));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.jsonrpc !== "2.0") return;
    const packet = event.data,
      request = pending.get(packet.id);
    if (request) {
      pending.delete(packet.id);
      clearTimeout(request.timer);
      packet.error ? request.reject(new Error(packet.error.message)) : request.resolve(packet.result);
    } else if (packet.method === "ui/resource-teardown") {
      void (dispose?.() ?? Promise.resolve())
        .catch(() => {})
        .finally(() => {
          parent.postMessage({ jsonrpc: "2.0", id: packet.id, result: {} }, "*");
          for (const value of pending.values()) {
            clearTimeout(value.timer);
            value.reject(new Error("DBX panel closed"));
          }
          pending.clear();
        });
    }
  });
  await rpc("ui/initialize", { appInfo: { name: "dbx", version }, appCapabilities: {}, protocolVersion: "2026-01-26" });
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
  const call: CodexCall = async (command) => {
    const result = await rpc("tools/call", { name: "dbx_codex_ui", arguments: command });
    if (result.isError) throw new Error("DBX UI request failed; it was not retried");
    return result.structuredContent;
  };
  dispose = () => call({ action: "dispose" });
  const fetch = createCodexFetch(call),
    original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://dbx.invalid");
    return url.pathname.startsWith("/api/") && (url.origin === location.origin || url.origin === "https://dbx.invalid") ? fetch(input instanceof Request ? input : url.pathname + url.search, init) : original(input, init);
  };
  installEventSource(fetch);
  installWebSocket(call);
  installDownloads(call);
  return call;
}
