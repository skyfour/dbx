function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "." || trimmed === "./" || trimmed === "/") return "";
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function inferredRuntimeBasePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  if (!normalized || normalized === "/login") return "";
  if (normalized.endsWith("/login")) return normalized.slice(0, -"/login".length);
  return normalized;
}

export function dbxWebBasePath(pathname = globalThis.location?.pathname ?? "", buildBase = import.meta.env.BASE_URL): string {
  if (import.meta.env.VITE_DBX_CODEX_APP) return "";
  const configured = normalizeBasePath(buildBase);
  if (configured) return configured;
  return normalizeBasePath(inferredRuntimeBasePath(pathname));
}

export function webPath(path: string, basePath = dbxWebBasePath()): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (import.meta.env.VITE_DBX_CODEX_APP) {
    const assets = (globalThis as typeof globalThis & { __DBX_CODEX_ASSETS__?: Map<string, string> }).__DBX_CODEX_ASSETS__;
    const asset = assets?.get(normalizedPath);
    if (asset) return asset;
  }
  if (import.meta.env.VITE_DBX_CODEX_APP && (normalizedPath === "/" || normalizedPath === "/login")) return `#${normalizedPath}`;
  const base = normalizeBasePath(basePath);
  return `${base}${normalizedPath}` || "/";
}

export function apiUrl(path: string, basePath = dbxWebBasePath()): string {
  const pathWithLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const normalizedPath = pathWithLeadingSlash === "/api" || pathWithLeadingSlash.startsWith("/api/") || pathWithLeadingSlash.startsWith("/api?") ? pathWithLeadingSlash : `/api${pathWithLeadingSlash}`;
  return webPath(normalizedPath, basePath);
}

type WebSocketLocation = Pick<Location, "protocol" | "host"> | undefined;

export function apiWebSocketUrl(path: string, basePath = dbxWebBasePath(), currentLocation: WebSocketLocation = globalThis.location): string {
  if (import.meta.env.VITE_DBX_CODEX_APP) return `ws://dbx.invalid${apiUrl(path, basePath)}`;
  const protocol = currentLocation?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${currentLocation?.host ?? ""}${apiUrl(path, basePath)}`;
}
