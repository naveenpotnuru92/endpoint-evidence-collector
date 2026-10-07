// Streaming archive readers. They NEVER write to disk: each member is hashed as it streams by.
// Untrusted input: every name/type/size is validated before use.
import { createReadStream, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { createGunzip, createInflateRaw } from "node:zlib";
import { createHash } from "node:crypto";
import type { VerifyLimits } from "./limits.js";

export interface MemberResult { name: string; bytes: number; sha256: string }
export interface ArchiveReadResult { members: MemberResult[]; problems: Problem[]; expandedBytes: number }
export interface Problem { code: string; message: string }

/** Returns an error code if a member name is unsafe to trust as a relative evidence path. */
export function badMemberName(name: string, lim: VerifyLimits): string | null {
  if (name.length === 0) return "empty-name";
  if (name.length > lim.maxMemberNameLength) return "name-too-long";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control-characters";
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return "absolute-path";
  if (name.includes("\\")) return "backslash-in-name";
  const segs = name.split("/");
  if (segs.length > lim.maxPathDepth) return "excessive-nesting";
  if (segs.some((s) => s === ".." )) return "path-traversal";
  if (segs.some((s) => s === "." || s === "")) return "ambiguous-segment";
  return null;
}

class Budget {
  expanded = 0; members = 0; start = Date.now();
  constructor(public lim: VerifyLimits, public shared: { expanded: number; members: number }) {}
  check(): string | null {
    if (Date.now() - this.start > this.lim.maxSeconds * 1000) return "time-limit";
    if (this.shared.expanded > this.lim.maxExpandedBytes) return "expanded-bytes-limit";
    if (this.shared.members > this.lim.maxMembers) return "member-count-limit";
    return null;
  }
}

export interface Shared { expanded: number; members: number }

// ---------------- tar.gz ----------------
export async function readTarGz(path: string, compressedBytes: number, lim: VerifyLimits, shared: Shared): Promise<ArchiveReadResult> {
  const out: ArchiveReadResult = { members: [], problems: [], expandedBytes: 0 };
  const seen = new Set<string>(); const budget = new Budget(lim, shared);
  const gz = createReadStream(path).pipe(createGunzip());
  let buf: Buffer = Buffer.alloc(0);
  let cur: { name: string; remaining: number; pad: number; hash: ReturnType<typeof createHash>; bytes: number; skip: boolean } | null = null;
  let pendingMeta: { kind: "x" | "L"; size: number; chunks: Buffer[]; pad: number } | null = null;
  let nextName: string | null = null;
  let zeroBlocks = 0;
  const fail = (code: string, message: string) => { out.problems.push({ code, message }); };

  try {
    for await (const chunk of gz as AsyncIterable<Buffer>) {
      shared.expanded += chunk.length; out.expandedBytes += chunk.length;
      const lim1 = budget.check(); if (lim1) { fail(lim1, "Verification limit reached; archive abandoned."); return out; }
      if (compressedBytes > 0 && out.expandedBytes / compressedBytes > lim.maxRatio && out.expandedBytes > 64 * 1024 * 1024) { fail("decompression-bomb", "Expansion ratio exceeds limit."); return out; }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (pendingMeta) {
          const need = pendingMeta.size + pendingMeta.pad;
          if (buf.length < need) break;
          pendingMeta.chunks.push(buf.subarray(0, pendingMeta.size)); buf = buf.subarray(need);
          const text = Buffer.concat(pendingMeta.chunks).toString("utf8");
          if (pendingMeta.kind === "L") nextName = text.replace(/\0.*$/s, "");
          else { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text); if (m) nextName = m[1]!; }
          pendingMeta = null; continue;
        }
        if (cur) {
          const take = Math.min(cur.remaining, buf.length);
          if (take > 0) { if (!cur.skip) cur.hash.update(buf.subarray(0, take)); cur.bytes += take; cur.remaining -= take; buf = buf.subarray(take); }
          if (cur.remaining > 0) break;
          if (buf.length < cur.pad) break;
          buf = buf.subarray(cur.pad);
          if (!cur.skip) out.members.push({ name: cur.name, bytes: cur.bytes, sha256: cur.hash.digest("hex") });
          cur = null; continue;
        }
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        if (h.every((b) => b === 0)) { zeroBlocks++; buf = buf.subarray(512); continue; }
        zeroBlocks = 0; buf = buf.subarray(512);
        const rawName = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
        const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
        const sizeStr = h.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
        const size = parseInt(sizeStr || "0", 8);
        const type = String.fromCharCode(h[156] || 48);
        if (!Number.isFinite(size) || size < 0) { fail("malformed-header", "Invalid member size in tar header."); return out; }
        if (type === "x" || type === "L") { pendingMeta = { kind: type, size, chunks: [], pad: (512 - (size % 512)) % 512 }; continue; }
        if (type === "g") { const sk = size + ((512 - (size % 512)) % 512); cur = { name: "", remaining: size, pad: (512 - (size % 512)) % 512, hash: createHash("sha256"), bytes: 0, skip: true }; void sk; continue; }
        const name = nextName ?? (prefix ? prefix + "/" + rawName : rawName); nextName = null;
        shared.members++;
        const bm = budget.check(); if (bm) { fail(bm, "Verification limit reached."); return out; }
        if (type !== "0" && type !== "\0" && type !== "5") {
          fail("unexpected-member-type", `Member '${printable(name)}' has disallowed type '${type}' (links/devices are rejected).`);
          cur = { name, remaining: size, pad: (512 - (size % 512)) % 512, hash: createHash("sha256"), bytes: 0, skip: true }; continue;
        }
        if (type === "5") continue; // directory entry
        const bad = badMemberName(name, lim);
        if (bad) { fail(bad, `Unsafe member name rejected: '${printable(name)}'.`); cur = { name, remaining: size, pad: (512 - (size % 512)) % 512, hash: createHash("sha256"), bytes: 0, skip: true }; continue; }
        const key = name.toLowerCase();
        const dup = seen.has(key); seen.add(key);
        if (dup) fail("duplicate-member", `Duplicate/ambiguous member '${printable(name)}'.`);
        cur = { name, remaining: size, pad: (512 - (size % 512)) % 512, hash: createHash("sha256"), bytes: 0, skip: dup };
      }
    }
    void zeroBlocks;
    if (cur || pendingMeta) fail("truncated-archive", "Archive ended in the middle of a member.");
  } catch (e) { fail("unreadable-archive", `Archive could not be read: ${(e as Error).message}`); }
  return out;
}

// ---------------- zip ----------------
export async function readZip(path: string, compressedBytes: number, lim: VerifyLimits, shared: Shared): Promise<ArchiveReadResult> {
  const out: ArchiveReadResult = { members: [], problems: [], expandedBytes: 0 };
  const fail = (code: string, message: string) => out.problems.push({ code, message });
  const budget = new Budget(lim, shared);
  let fd = -1;
  try {
    fd = openSync(path, "r"); const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65557); const tail = Buffer.alloc(tailLen); readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) { fail("malformed-zip", "End-of-central-directory not found."); return out; }
    const total = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (total === 0xffff || cdOff === 0xffffffff) { fail("unsupported-zip64", "ZIP64 archives are not supported."); return out; }
    if (total > lim.maxMembers || cdSize > 512 * 1024 * 1024) { fail("member-count-limit", "Central directory too large."); return out; }
    const cd = Buffer.alloc(cdSize); readSync(fd, cd, 0, cdSize, cdOff);
    const seen = new Set<string>(); let p = 0;
    for (let n = 0; n < total; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) { fail("malformed-zip", "Bad central directory entry."); break; }
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38), lho = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString("utf8");
      p += 46 + nlen + xlen + clen;
      shared.members++;
      const lb = budget.check(); if (lb) { fail(lb, "Verification limit reached."); break; }
      if (name.endsWith("/")) continue;
      const bad = badMemberName(name, lim);
      if (bad) { fail(bad, `Unsafe member name rejected: '${printable(name)}'.`); continue; }
      if (flags & 1) { fail("encrypted-member", `Encrypted member '${printable(name)}' is unsupported.`); continue; }
      const unixMode = (ext >>> 16) & 0xf000;
      if (unixMode === 0xa000) { fail("unexpected-member-type", `Symlink member '${printable(name)}' rejected.`); continue; }
      const key = name.toLowerCase(); if (seen.has(key)) { fail("duplicate-member", `Duplicate/ambiguous member '${printable(name)}'.`); continue; } seen.add(key);
      if (usize > lim.maxExpandedBytes || (csize > 0 && usize / csize > lim.maxRatio && usize > 64 * 1024 * 1024)) { fail("decompression-bomb", `Member '${printable(name)}' exceeds expansion limits.`); continue; }
      if (method !== 0 && method !== 8) { fail("unsupported-compression", `Member '${printable(name)}' uses unsupported compression ${method}.`); continue; }
      const lh = Buffer.alloc(30); readSync(fd, lh, 0, 30, lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) { fail("malformed-zip", `Bad local header for '${printable(name)}'.`); continue; }
      const dataStart = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const { sha, bytes, err } = await hashZipData(path, dataStart, csize, method, lim.maxExpandedBytes - shared.expanded);
      if (err) { fail("unreadable-member", `Member '${printable(name)}': ${err}`); continue; }
      shared.expanded += bytes; out.expandedBytes += bytes;
      if (bytes !== usize) { fail("size-mismatch", `Member '${printable(name)}' size differs from header.`); continue; }
      out.members.push({ name, bytes, sha256: sha });
    }
  } catch (e) { fail("unreadable-archive", `Archive could not be read: ${(e as Error).message}`); }
  finally { if (fd >= 0) closeSync(fd); }
  void compressedBytes;
  return out;
}

function hashZipData(path: string, start: number, csize: number, method: number, maxOut: number): Promise<{ sha: string; bytes: number; err?: string }> {
  return new Promise((resolve) => {
    const h = createHash("sha256"); let bytes = 0; let done = false;
    const finish = (err?: string) => { if (done) return; done = true; resolve({ sha: h.digest("hex"), bytes, err }); };
    if (csize === 0) return finish();
    const rs = createReadStream(path, { start, end: start + csize - 1 });
    const src = method === 8 ? rs.pipe(createInflateRaw()) : rs;
    src.on("data", (c: Buffer) => { bytes += c.length; if (bytes > maxOut) { finish("expanded-bytes-limit"); rs.destroy(); return; } h.update(c); });
    src.on("end", () => finish()); src.on("error", (e: Error) => finish(e.message)); rs.on("error", (e) => finish(e.message));
  });
}

/** Strip control chars and cap length for any untrusted string shown to the operator. */
export function printable(s: string): string { return s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200); }
