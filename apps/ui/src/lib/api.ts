// Tiny client for the loopback service. The session token is injected into index.html by the service (never stored on disk).
const token = () => document.querySelector<HTMLMetaElement>('meta[name="eec-token"]')?.content ?? "";

export async function api<T>(path: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}): Promise<T> {
  const res = await fetch(path, { method: init.method ?? "GET", headers: { "x-eec-token": token(), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const e = new Error((data as { error?: string })?.error ?? `Request failed (${res.status})`) as Error & { issues?: string[]; status?: number }; e.issues = (data as { issues?: string[] })?.issues; e.status = res.status; throw e; }
  return data as T;
}
export async function fetchText(path: string): Promise<string> { const r = await fetch(path, { headers: { "x-eec-token": token() } }); if (!r.ok) throw new Error(`Request failed (${r.status})`); return r.text(); }

export function download(name: string, data: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
