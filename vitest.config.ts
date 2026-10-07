import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "apps/**/src/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 } });
