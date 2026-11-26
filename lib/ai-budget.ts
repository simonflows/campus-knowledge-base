import { createHash } from "node:crypto";
import type { AccountRateBucket, AccountStore } from "./account-service";
import { dynamoAccountStore } from "./account-storage";

type BudgetKind = "canon" | "web";
type BudgetDecision = { allowed: true } | { allowed: false; reason: "quota" | "unavailable" };
const daySeconds = 86_400;
const allowed: BudgetDecision = { allowed: true };
const unavailable: BudgetDecision = { allowed: false, reason: "unavailable" };

export function createAiBudget(
  store: Pick<AccountStore, "consumeRate">,
  now: () => number = Date.now,
  env: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
) {
  return async function consumeAiBudget(accountId: string, kind: BudgetKind): Promise<BudgetDecision> {
    if (kind === "canon" && env.CAMPUS_EMAIL_ACCOUNTS_ENABLED !== "true" &&
        env.CAMPUS_YANDEX_OAUTH_ENABLED !== "true") return allowed;
    if (kind === "web" && env.CAMPUS_WEB_SEARCH_ENABLED !== "true") return unavailable;
    if (!accountId.trim() || accountId.length > 256 || env.USE_DATABASE === "false" || env.OUTPUT_MODE === "export" ||
        (env.NODE_ENV !== "production" && env.CAMPUS_LOCAL_DEMO === "true")) return unavailable;

    const current = new Date(now());
    const day = Math.floor(current.getTime() / (daySeconds * 1000));
    const account = createHash("sha256").update(accountId).digest("hex");
    const dayPrefix = `ai:${kind}:day:${day}`;
    const expiresAt = (day + 2) * daySeconds;
    const buckets: AccountRateBucket[] = [
      { id: `${dayPrefix}:user:${account}`, limit: kind === "web" ? 5 : 50, expiresAt },
      { id: `${dayPrefix}:site`, limit: kind === "web" ? 50 : 1000, expiresAt },
    ];
    if (kind === "web") {
      const year = current.getUTCFullYear();
      const month = current.getUTCMonth();
      buckets.push({
        id: `ai:web:month:${year}-${month + 1}:site`, limit: 200,
        expiresAt: Date.UTC(year, month + 1, 1) / 1000 + daySeconds,
      });
    }

    try {
      // Consume all counters in the existing conditional DynamoDB transaction.
      return await store.consumeRate(buckets) ? allowed : { allowed: false, reason: "quota" };
    } catch {
      return unavailable;
    }
  };
}

export const consumeAiBudget = createAiBudget(dynamoAccountStore);
