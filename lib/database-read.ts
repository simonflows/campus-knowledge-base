import { setTimeout as wait } from "node:timers/promises";

const PAGE_DEADLINE_MS = 8_000;
const RETRY_DELAYS_MS = [100, 300];
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const THROTTLE_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);
const TIMEOUT_NAMES = new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException"]);
const TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"]);
const NON_RETRYABLE_NAMES = new Set([
  "AbortError",
  "AccessDenied",
  "AccessDeniedException",
  "ConditionalCheckFailedException",
  "ExpiredTokenException",
  "IncompleteSignature",
  "InvalidSignatureException",
  "MissingAuthenticationTokenException",
  "NotFound",
  "NotFoundException",
  "ResourceNotFoundException",
  "SerializationException",
  "UnauthorizedException",
  "UnauthorizedOperation",
  "UnrecognizedClientException",
  "ValidationError",
  "ValidationException",
]);

function isTransientReadFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const failure = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = failure.name ?? "";
  if (NON_RETRYABLE_NAMES.has(name)) return false;

  const status = failure.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    return RETRYABLE_STATUS.has(status) || (status === 400 && (THROTTLE_NAMES.has(name) || TIMEOUT_NAMES.has(name)));
  }
  return THROTTLE_NAMES.has(name) || TIMEOUT_NAMES.has(name) ||
    TRANSPORT_CODES.has(failure.code ?? "");
}

/** Retry only an idempotent read page, sharing one deadline across the SDK calls and waits. */
export async function runDatabaseRead<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  externalSignal?.throwIfAborted();
  const deadline = AbortSignal.timeout(PAGE_DEADLINE_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const value = await operation(signal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientReadFailure(error)) throw error;
      try {
        await wait(delay, undefined, { signal });
      } catch (waitError) {
        signal.throwIfAborted();
        throw waitError;
      }
    }
  }
}
