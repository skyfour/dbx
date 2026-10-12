import { describe, expect, it, vi } from "vitest";
import { createCodexFetch, parseEventStream, saveCodexDownload } from "./codexTransport";

describe("Codex UI transport", () => {
  it("closes an SSE response when its consumer fails", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: progress\n\n"));
      },
      cancel,
    });
    await expect(
      parseEventStream(stream, () => {
        throw new Error("Consumer failed");
      }),
    ).rejects.toThrow("Consumer failed");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels the download response if authentication or opening the destination fails", async () => {
    for (const status of [200, 401]) {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { status });
      await expect(
        saveCodexDownload(
          async () => {
            throw new Error("Cannot open destination");
          },
          response,
          "file.csv",
        ),
      ).rejects.toThrow();
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("releases success responses for repeated void HTTP calls", async () => {
    const { saveMaxAgentTurns } = await import("./http");
    const streams = new Set<string>();
    let next = 0;
    const fetch = createCodexFetch(async (command) => {
      if (command.action === "open") {
        const id = String(++next);
        streams.add(id);
        expect(streams.size).toBeLessThan(128);
        return { id };
      }
      if (command.action === "read") return { type: "headers", status: 200, headers: { "content-type": "application/json" } };
      if (command.action === "close") streams.delete(command.id!);
      return {};
    });
    vi.stubGlobal("fetch", fetch);
    try {
      for (let i = 0; i < 140; i++) await saveMaxAgentTurns(10);
      expect(streams.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("saves large binary exports in bounded chunks and removes incomplete exports", async () => {
    const bytes = new Uint8Array(140000).map((_, i) => i % 256),
      saved: number[] = [];
    const path = await saveCodexDownload(
      async (command) => {
        if (command.action === "export_open") return { id: "export" };
        expect(command.action).toBe("export_write");
        if (command.data) {
          expect(atob(command.data).length).toBeLessThanOrEqual(65536);
          saved.push(...Array.from(atob(command.data), (c) => c.charCodeAt(0)));
        }
        return command.end ? { path: "/private/exports/report.bin" } : {};
      },
      new Response(bytes),
      "report.bin",
    );
    expect(path).toBe("/private/exports/report.bin");
    expect(saved).toEqual([...bytes]);
    const actions: string[] = [];
    await expect(
      saveCodexDownload(
        async (command) => {
          actions.push(command.action);
          if (command.action === "export_open") return { id: "bad" };
          if (command.action === "export_write") throw new Error("Disk full");
          return {};
        },
        new Response(bytes),
        "bad.bin",
      ),
    ).rejects.toThrow("Disk full");
    expect(actions[actions.length - 1]).toBe("close");
  });
  it("preserves Request method, body and init overrides", async () => {
    const actions: any[] = [];
    const fetch = createCodexFetch(async (command) => {
      actions.push(command);
      if (command.action === "open") return { id: "request" };
      if (command.action === "read") return { type: "headers", status: 204, headers: {} };
      return {};
    });
    await fetch(new Request("https://dbx.invalid/api/write", { method: "POST", body: "payload" }), { headers: { "content-type": "text/plain" } });
    expect(actions[0]).toMatchObject({ method: "POST", body: true, headers: { "content-type": "text/plain" } });
    expect(atob(actions.find((c) => c.data).data)).toBe("payload");
  });
  it("preserves binary upload and streamed response bytes without exposing cookies", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const received: number[] = [];
    const packets = [{ type: "headers", status: 201, headers: { "content-type": "application/octet-stream" } }, { type: "data", data: btoa(String.fromCharCode(...bytes)) }, { type: "end" }];
    const fetch = createCodexFetch(async (request) => {
      if (request.action === "open") {
        expect(request.path).toBe("/api/upload");
        expect(request.body).toBe(true);
        return { id: "stream" };
      }
      if (request.action === "write") {
        if (request.data)
          received.push(
            ...atob(request.data)
              .split("")
              .map((c) => c.charCodeAt(0)),
          );
        return { ok: true };
      }
      if (request.action === "read") return packets.shift()!;
      throw new Error("Unexpected operation");
    });
    const response = await fetch("/api/upload", { method: "POST", body: bytes });
    expect(response.status).toBe(201);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(received).toEqual([...bytes]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("cancels an active response once and never replays the request", async () => {
    const actions: string[] = [];
    const controller = new AbortController();
    const fetch = createCodexFetch(async (request) => {
      actions.push(request.action);
      if (request.action === "open") return { id: "stream" };
      if (request.action === "read") return { type: "headers", status: 200, headers: {} };
      return { ok: true };
    });
    const response = await fetch("/api/query", { method: "POST", signal: controller.signal });
    controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    expect(actions.filter((a) => a === "open")).toHaveLength(1);
    expect(actions.filter((a) => a === "close")).toHaveLength(1);
  });
  it("rejects foreign URLs and handles chunked SSE with multiline data and event IDs", async () => {
    const fetch = createCodexFetch(async () => {
      throw new Error("Must not call native transport");
    });
    await expect(fetch("https://example.com/api/private")).rejects.toThrow(/DBX API/);
    const events: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const data = new TextEncoder().encode("id: 7\r\nevent: progress\r\ndata: 中文\r\ndata: second\r\n\r\n");
        for (const b of data) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    await parseEventStream(stream, (e) => events.push(e));
    expect(events).toEqual([{ type: "progress", data: "中文\nsecond", lastEventId: "7" }]);
  });
});
