import type { TargetOs } from "./constants.js";

export interface PathIssue { message: string }

const CTRL = /[\u0000-\u001f\u007f]/;
const WIN_BAD = /[<>"|?*]/;
const GLOB_POSIX = /[*?\[\]{}]/;

/** Directories that must never be an output root (or lie inside one of these evidence/system trees). */
const UNSAFE_ROOTS: Record<TargetOs, string[]> = {
  windows: ["c:\\", "c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\users", "c:\\programdata"],
  macos: ["/", "/system", "/usr", "/bin", "/sbin", "/etc", "/private", "/private/etc", "/var", "/library", "/users", "/applications", "/volumes"],
  linux: ["/", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/boot", "/dev", "/proc", "/sys", "/var", "/var/log", "/home", "/root", "/run"],
};
/** Evidence source trees — an output root inside these would be collected recursively or pollute evidence. */
const SOURCE_TREES: Record<TargetOs, string[]> = {
  windows: ["c:\\windows\\system32\\winevt", "c:\\windows\\system32\\tasks", "c:\\windows\\system32\\config"],
  macos: ["/var/log", "/private/var/log", "/library/launchdaemons", "/library/launchagents", "/private/var/at"],
  linux: ["/var/log", "/etc/cron.d", "/etc/systemd", "/var/spool/cron"],
};

export function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/** Basic structural validation of an absolute, literal endpoint path. Returns issue message or null. */
export function checkLiteralPath(p: string, os: TargetOs): string | null {
  if (p.length === 0) return "Path is empty.";
  if (p.length > 260 && os === "windows") return "Path exceeds 260 characters.";
  if (p.length > 1024) return "Path exceeds 1024 characters.";
  if (CTRL.test(p)) return "Path contains control characters or newlines.";
  if (p.includes("\u0000")) return "Path contains NUL.";
  if (os === "windows") {
    if (p.startsWith("\\\\") || p.startsWith("//")) return "Network/UNC and device paths are not supported in version one.";
    if (!isWindowsAbsolute(p)) return "Path must be absolute with a drive letter (for example C:\\Evidence).";
    const rest = p.slice(2);
    if (WIN_BAD.test(rest)) return "Path contains characters that are invalid on Windows or look like globs (<>\"|?*).";
    if (rest.includes(":")) return "Alternate data streams / extra colons are not allowed.";
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    if (parts.some((s) => s === ".." || s === ".")) return "Path traversal segments ('.' or '..') are not allowed.";
    if (parts.some((s) => /[. ]$/.test(s))) return "Path segments cannot end with a dot or space on Windows.";
    if (parts.some((s) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s))) return "Reserved Windows device names are not allowed.";
  } else {
    if (!p.startsWith("/")) return "Path must be absolute (start with '/').";
    if (p.startsWith("//")) return "Paths starting with '//' are ambiguous and not allowed.";
    if (GLOB_POSIX.test(p)) return "Globs and brace expressions are not supported; provide literal paths.";
    const parts = p.split("/").filter(Boolean);
    if (parts.some((s) => s === ".." || s === ".")) return "Path traversal segments ('.' or '..') are not allowed.";
    if (p.includes("~") && /(^|\/)~/.test(p)) return "Tilde expansion is not performed; use absolute paths.";
    if (p.includes("$") || p.includes("`")) return "Variable or command substitution characters ('$', backtick) are not allowed in paths.";
  }
  return null;
}

export function normalizeForCompare(p: string, os: TargetOs): string {
  let n = p.replace(/\\/g, os === "windows" ? "\\" : "/");
  if (os === "windows") n = n.replace(/\//g, "\\").toLowerCase();
  else if (os === "macos") n = n.toLowerCase(); // default APFS is case-insensitive; be conservative
  n = n.replace(/[\\/]+$/, "");
  return n === "" ? (os === "windows" ? "" : "/") : n;
}

function isInside(child: string, parent: string, os: TargetOs): boolean {
  const sep = os === "windows" ? "\\" : "/";
  if (parent === "/" || parent.endsWith(":")) return true;
  return child === parent || child.startsWith(parent + sep);
}

export function checkOutputRoot(p: string, os: TargetOs): string | null {
  const base = checkLiteralPath(p, os);
  if (base) return base;
  const n = normalizeForCompare(p, os);
  const normalizedWinRoot = os === "windows" && /^[a-z]:$/.test(n);
  if (normalizedWinRoot) return "A drive root is not an acceptable output root; choose a dedicated directory.";
  for (const u of UNSAFE_ROOTS[os]) {
    const nu = normalizeForCompare(u, os);
    if (n === nu) return `'${p}' is a protected system location; choose a dedicated evidence directory below it.`;
  }
  for (const s of SOURCE_TREES[os]) {
    if (isInside(n, normalizeForCompare(s, os), os)) return `Output root would sit inside an evidence source tree (${s}).`;
  }
  const depth = n.split(os === "windows" ? "\\" : "/").filter(Boolean).length;
  if (depth < (os === "windows" ? 2 : 2)) return "Output root must be at least two levels deep (for example /var/tmp/evidence or C:\\IR\\Evidence).";
  return null;
}

/** True if a custom path would sit inside or contain the output root (recursive collection hazard). */
export function overlapsOutput(custom: string, outputRoot: string, os: TargetOs): boolean {
  const a = normalizeForCompare(custom, os);
  const b = normalizeForCompare(outputRoot, os);
  return isInside(a, b, os) || isInside(b, a, os);
}
