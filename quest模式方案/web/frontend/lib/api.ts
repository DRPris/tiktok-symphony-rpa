// Lightweight fetch wrapper for Symphony backend.
// All routes are proxied via next.config.js → http://localhost:8000

export type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

const buildQuery = (q?: ApiOptions["query"]) => {
  if (!q) return "";
  const usp = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null) usp.set(k, String(v));
  });
  const s = usp.toString();
  return s ? `?${s}` : "";
};

export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {}
): Promise<T> {
  const { body, query, headers, ...rest } = opts;
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}${buildQuery(query)}`, {
    ...rest,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(headers || {}),
    },
    body: body
      ? isForm
        ? (body as FormData)
        : JSON.stringify(body)
      : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : msg;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return res.text() as unknown as Promise<T>;
}
