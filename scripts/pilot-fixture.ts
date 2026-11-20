import { randomBytes, createHash } from "node:crypto";
import { demoAccounts } from "../lib/auth";
import { authenticatePilot } from "../lib/pilot-auth";

/** Synthetic credentials exist only in this test process and are never printed. */
export function installPilotFixture() {
  const keys = new Map<string, string>();
  const rows = demoAccounts.map(profile => {
    const login = "qa-" + profile.id.slice(5);
    const key = randomBytes(32).toString("base64url");
    keys.set(profile.id, key);
    return { login, name: "QA " + login, profile: profile.id, keyHash: createHash("sha256").update(key).digest("hex") };
  });
  process.env.CAMPUS_DEMO_LOGIN = "false";
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.CAMPUS_PILOT_ACCOUNTS = JSON.stringify(rows);
  return {
    rows,
    keys,
    account(profile: string) {
      const row = rows.find(row => row.profile === profile)!;
      const user = authenticatePilot(row.login, keys.get(profile));
      if (!user) throw new Error("Fixture account not configured");
      return user;
    },
  };
}
