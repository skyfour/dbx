import { describe, expect, it, vi, afterEach } from "vitest";
import { apiUrl, apiWebSocketUrl, dbxWebBasePath, webPath } from "@/lib/common/webPath";

describe("webPath", () => {
  afterEach(()=>vi.unstubAllEnvs());
  it("keeps Codex assets and API paths while using fragment-only auth navigation",()=>{
    vi.stubEnv("VITE_DBX_CODEX_APP",true);
    expect(dbxWebBasePath("/mcp-app/dbx","/host/")).toBe("");
    expect(webPath("/login")).toBe("#/login");
    expect(webPath("/")).toBe("#/");
    expect(webPath("/icons/database/mysql.svg")).toBe("/icons/database/mysql.svg");
    expect(apiUrl("/auth/check")).toBe("/api/auth/check");
    expect(apiWebSocketUrl("/redis/pubsub/ws")).toBe("ws://dbx.invalid/api/redis/pubsub/ws");
  });
  it("keeps root deployments on root-relative API paths", () => {
    expect(dbxWebBasePath("/", "/")).toBe("");
    expect(apiUrl("/api/auth/check", "")).toBe("/api/auth/check");
  });

  it("uses an explicit build base path", () => {
    expect(dbxWebBasePath("/", "/dbx/")).toBe("/dbx");
    expect(webPath("/login", "/dbx")).toBe("/dbx/login");
    expect(webPath("/", "/dbx")).toBe("/dbx/");
    expect(webPath("/icons/database/mysql.svg", "/dbx")).toBe("/dbx/icons/database/mysql.svg");
    expect(webPath("/icons/ai/openai.svg", "/dbx")).toBe("/dbx/icons/ai/openai.svg");
    expect(webPath("/logo.png", "/dbx")).toBe("/dbx/logo.png");
    expect(webPath("/logo-black.png", "/dbx")).toBe("/dbx/logo-black.png");
    expect(webPath("/icon-preview-default.png", "/dbx")).toBe("/dbx/icon-preview-default.png");
    expect(webPath("/icon-preview-black.png", "/dbx")).toBe("/dbx/icon-preview-black.png");
    expect(apiUrl("/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
    expect(apiUrl("/api/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
    expect(apiUrl("api/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
  });

  it("infers the runtime base path from the login URL for relative builds", () => {
    expect(dbxWebBasePath("/dbx/login", "./")).toBe("/dbx");
    expect(dbxWebBasePath("/tools/dbx/login", "./")).toBe("/tools/dbx");
  });

  it("infers the runtime base path from a mounted relative build", () => {
    expect(dbxWebBasePath("/dbx/", "./")).toBe("/dbx");
    expect(dbxWebBasePath("/tools/dbx/", "./")).toBe("/tools/dbx");
  });

  it("builds websocket URLs with the configured base path", () => {
    expect(apiWebSocketUrl("/redis/session/123", "/dbx", { protocol: "https:", host: "example.test" })).toBe("wss://example.test/dbx/api/redis/session/123");
  });
});
