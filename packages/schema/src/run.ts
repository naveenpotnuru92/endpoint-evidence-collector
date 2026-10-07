// Run-side formats: status file, run manifest, and the external retrieval index.
// These are produced by endpoint collectors and consumed (as UNTRUSTED input) by the verifier.
import { z } from "zod";

export const RUN_STATES = ["preflight", "collecting", "packaging", "complete", "partial", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Deterministic collector exit codes (documented in docs/operator-guide.md). */
export const EXIT_CODES = {
  complete: 0,
  partial: 10,
  preflightFailure: 20,
  interrupted: 30,
  packagingFailure: 40,
} as const;

const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const nonNegInt = z.number().int().min(0);

export const StatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().regex(RUN_ID),
  planId: z.string(),
  state: z.enum(RUN_STATES),
  currentArtifact: z.string().max(200).nullable(),
  startedUtc: z.string(),
  updatedUtc: z.string(),
  collectedBytes: nonNegInt,
  counts: z.strictObject({ ok: nonNegInt, partial: nonNegInt, failed: nonNegInt, skipped: nonNegInt }),
  failureSummary: z.array(z.string().max(500)).max(100),
});

export const OUTCOMES = ["collected", "partial", "failed", "skipped"] as const;
export const METHODS = ["copy", "export", "snapshot", "command-output", "metadata"] as const;

export const ManifestEntrySchema = z.strictObject({
  artifactId: z.string(),
  profile: z.string().max(128).nullable(),
  sourcePath: z.string().max(2048).nullable(),
  destination: z.string().max(2048).nullable(),
  method: z.enum(METHODS),
  outcome: z.enum(OUTCOMES),
  acquiredUtc: z.string().nullable(),
  bytes: nonNegInt,
  sha256: z.string().regex(HEX64).nullable(),
  error: z.string().max(1000).nullable(),
  skipReason: z.string().max(200).nullable(),
  consistencyNote: z.string().max(300).nullable(),
  timeFilterApplied: z.boolean(),
});

export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().regex(RUN_ID),
  planId: z.string(),
  planDigest: z.string().regex(HEX64),
  catalogVersion: z.string(),
  generatorVersion: z.string(),
  targetOs: z.enum(["windows", "macos", "linux"]),
  host: z.strictObject({ name: z.string().max(255), osVersion: z.string().max(255), identity: z.string().max(255), elevated: z.boolean() }),
  startedUtc: z.string(),
  finishedUtc: z.string().nullable(),
  entries: z.array(ManifestEntrySchema).max(200_000),
});

export const IndexPartSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  bytes: nonNegInt,
  sha256: z.string().regex(HEX64),
  members: nonNegInt,
});

export const RetrievalIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().regex(RUN_ID),
  planId: z.string(),
  planDigest: z.string().regex(HEX64),
  finalizationState: z.enum(["complete", "partial", "failed", "cancelled"]),
  manifestName: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  manifestSha256: z.string().regex(HEX64),
  expectedParts: z.array(IndexPartSchema).max(1000),
  failedParts: z.array(z.string().max(200)).max(1000),
});

export type Status = z.infer<typeof StatusSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type RetrievalIndex = z.infer<typeof RetrievalIndexSchema>;
