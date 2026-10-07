// Deterministic archive writers (fixed timestamps/ownership) so identical input yields identical bytes.
import { crc32, gzipSync } from "node:zlib";

export interface PkgFile { name: string; data: Uint8Array; mode?: number }

const enc = new TextEncoder();
const FIXED_DOS_TIME = 0;             // 00:00:00
const FIXED_DOS_DATE = (1 << 5) | 1;  // 1980-01-01

/** STORE-only ZIP (no compression) — simple, reviewable, readable by Expand-Archive/unzip. */
export function zipStore(files: PkgFile[]): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, FIXED_DOS_TIME, true); lh.setUint16(12, FIXED_DOS_DATE, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x031e, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, FIXED_DOS_TIME, true); ch.setUint16(14, FIXED_DOS_DATE, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(38, ((f.mode ?? 0o644) << 16) >>> 0, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

function octal(n: number, len: number): Uint8Array {
  return enc.encode(n.toString(8).padStart(len - 1, "0") + "\0");
}

/** ustar tar.gz with mtime 0, uid/gid 0. */
export function tarGz(files: PkgFile[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const h = new Uint8Array(512);
    const name = enc.encode(f.name);
    if (name.length > 100) throw new Error("tar member name too long: " + f.name);
    h.set(name, 0);
    h.set(octal(f.mode ?? 0o644, 8), 100); h.set(octal(0, 8), 108); h.set(octal(0, 8), 116);
    h.set(octal(f.data.length, 12), 124); h.set(octal(0, 12), 136);
    h.set(enc.encode("        "), 148); h[156] = "0".charCodeAt(0);
    h.set(enc.encode("ustar\0" + "00"), 257);
    let sum = 0; for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(h, f.data, new Uint8Array((512 - (f.data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(concat(blocks), { level: 9 }));
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
