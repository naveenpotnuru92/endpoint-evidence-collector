export interface VerifyLimits {
  maxImportBytes: number;      // total size of imported (compressed) files
  maxExpandedBytes: number;    // total bytes streamed out of archives
  maxMembers: number;          // total archive members across parts
  maxMemberNameLength: number;
  maxPathDepth: number;
  maxRatio: number;            // expanded/compressed ratio bomb guard (per part)
  maxSeconds: number;
  maxJsonBytes: number;        // index/manifest size
}
export const DEFAULT_VERIFY_LIMITS: VerifyLimits = {
  maxImportBytes: 8 * 1024 ** 3, maxExpandedBytes: 16 * 1024 ** 3, maxMembers: 200_000,
  maxMemberNameLength: 512, maxPathDepth: 32, maxRatio: 2000, maxSeconds: 600, maxJsonBytes: 256 * 1024 ** 2,
};
