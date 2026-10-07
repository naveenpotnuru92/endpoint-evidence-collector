// Builds the distributable local release bundle: release/eec-<version>/ (+ .tar.gz and SHA-256).
// The bundle is UNSIGNED and NOT notarized. It needs Node >= 22 on the operator's Mac (documented in the README).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = process.cwd(); const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const out = join(root, "release", `eec-${version}`); rmSync(join(root, "release"), { recursive: true, force: true }); mkdirSync(out, { recursive: true });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
await build({ entryPoints: [join(root, "apps/local-service/src/main.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: join(out, "server.mjs"),
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, legalComments: "none", logLevel: "warning" });
cpSync(join(root, "apps/ui/dist"), join(out, "ui"), { recursive: true });
cpSync(join(root, "collectors"), join(out, "collectors"), { recursive: true });
cpSync(join(root, "docs"), join(out, "docs"), { recursive: true, filter: (p) => !p.includes("screenshots") });
for (const f of ["README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"]) cpSync(join(root, f), join(out, f));
writeFileSync(join(out, "start.sh"), `#!/bin/bash
# Launches the local planner on 127.0.0.1 and opens it in your browser. Requires Node.js >= 22.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js >= 22 is required (https://nodejs.org)."; exit 1; }
exec node server.mjs
`); chmodSync(join(out, "start.sh"), 0o755);
const files: string[] = []; (function walk(d: string) { for (const n of readdirSync(d).sort()) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(out);
writeFileSync(join(out, "BUNDLE-MANIFEST.txt"), files.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${f.slice(out.length + 1)}`).join("\n") + "\nNOTE: unsigned, not notarized. Verify this manifest against the tarball digest you received.\n");
const tgz = join(root, "release", `eec-${version}.tar.gz`);
execFileSync("tar", ["-czf", tgz, "-C", join(root, "release"), `eec-${version}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log(`bundle: ${tgz}\nsha256: ${createHash("sha256").update(readFileSync(tgz)).digest("hex")}`);
