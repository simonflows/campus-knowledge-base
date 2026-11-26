export function conditionalTransactionCancellation(error: unknown) {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return null;
  const reasons: unknown = "CancellationReasons" in error ? error.CancellationReasons : undefined;
  const codes: (string | undefined)[] = Array.isArray(reasons) ? reasons.map(reason => reason?.Code) : [];
  if (codes.some(code => code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(code))) return null;
  if (codes.includes("ConditionalCheckFailed")) return { kind: "condition", codes } as const;
  if (codes.includes("TransactionConflict")) return { kind: "conflict" } as const;
  // The YDB Document API can cancel an atomic write without positional reasons.
  return { kind: "unknown" } as const;
}
