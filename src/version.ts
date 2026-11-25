/**
 * Package version — the single source of truth for every version string
 * this package stamps into artifacts (generator lines, evidence manifests,
 * archive ZIP metadata). The literal is kept deliberately plain (no
 * build-time injection) so the tsdown config stays untouched; a guard test
 * (test/version.test.ts) asserts it equals package.json's version, so a
 * forgotten bump fails CI instead of drifting.
 *
 * @module dsh-session-export/version
 */
export const VERSION = '1.11.2'
