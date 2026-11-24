import type { FactCheckFinding, FactCheckResult } from "./fact-check";

export type RewriteCheck = {
  summary: FactCheckResult["summary"];
  canPublish: boolean;
  isClean: boolean;
  /** Optional for compatibility with reports produced before 0.9.9. */
  findings?: FactCheckFinding[];
};

export function summarizeRewrite(result: FactCheckResult): RewriteCheck {
  return {
    summary: result.summary,
    canPublish: result.canPublish,
    isClean: result.summary.red === 0 && result.summary.yellow === 0,
    findings: result.findings,
  };
}

/** Keep a visible example of each verdict when the report is collapsed. */
export function previewFindings(findings: FactCheckFinding[], limit = 6) {
  const size = Math.max(0, Math.floor(limit));
  if (findings.length <= size) return findings;
  const selected = new Set<number>();
  for (const level of ["red", "yellow", "green"] as const) {
    const index = findings.findIndex((finding) => finding.level === level);
    if (index >= 0 && selected.size < size) selected.add(index);
  }
  for (
    let index = 0;
    index < findings.length && selected.size < size;
    index++
  ) {
    selected.add(index);
  }
  return [...selected].sort((a, b) => a - b).map((index) => findings[index]);
}
