import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { demoAccounts, getDemoAccount, normalizeOwnerLabel, toSessionUser, type SessionUser } from "./auth";

export function demoLoginEnabled() {
  return process.env.CAMPUS_DEMO_LOGIN === "true";
}

const pilotDirectorySchema = z.array(z.object({
  login: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(2).max(160),
  profile: z.string().refine((id) => Boolean(getDemoAccount(id))),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
})).min(1).max(2000);

function pilotDirectory() {
  try {
    const rows = pilotDirectorySchema.parse(JSON.parse(process.env.CAMPUS_PILOT_ACCOUNTS || "[]"));
    if (new Set(rows.map(row => row.login)).size !== rows.length || new Set(rows.map(row => row.keyHash)).size !== rows.length) return [];
    // Old cards can identify a person by name alone. Require their organization
    // when the personal directory and legacy profiles assign that name to different organizations.
    const organizationsByName = new Map<string, Set<string>>();
    function registerName(name: string, organization: string) {
      const label = normalizeOwnerLabel(name);
      const organizations = organizationsByName.get(label) ?? new Set<string>();
      organizations.add(organization);
      organizationsByName.set(label, organizations);
    }
    for (const profile of demoAccounts) {
      for (const name of [...profile.ownerAliases, ...profile.organizationAliases]) registerName(name, profile.organization);
    }
    for (const row of rows) {
      const profile = getDemoAccount(row.profile)!;
      if (profile.ownerAliases.length) registerName(row.name, profile.organization);
    }
    return rows.map(row => {
      const profile = toSessionUser(getDemoAccount(row.profile)!);
      const names = profile.ownerAliases.length ? new Set([...profile.ownerAliases, row.name]) : [];
      const user: SessionUser = {
        ...profile,
        id: "pilot-" + row.login,
        name: row.name,
        ownershipLabel: row.name + ", " + profile.organization,
        ownerAliases: Array.from(names, name => organizationsByName.get(normalizeOwnerLabel(name))!.size > 1
          ? name + ", " + profile.organization
          : name),
      };
      return { user, row };
    });
  } catch {
    return [];
  }
}

export function sessionDirectory(): SessionUser[] {
  return demoLoginEnabled() ? demoAccounts.map(toSessionUser) : pilotDirectory().map(entry => entry.user);
}

export function getSessionIdentity(id: string) {
  if (demoLoginEnabled()) {
    const account = getDemoAccount(id);
    if (!account) return null;
    const pin = account.role === "admin" ? process.env.ADMIN_ACCESS_PIN?.trim() : undefined;
    const binding = pin ? "demo-admin:" + createHash("sha256").update(pin).digest("hex") : "demo";
    return { user: toSessionUser(account), binding };
  }
  const entry = pilotDirectory().find(entry => entry.user.id === id);
  return entry && { user: entry.user, binding: JSON.stringify(entry.row) };
}

export function pilotLoginReady() {
  return Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 && pilotDirectory().length);
}

export function authenticatePilot(login: string, key: string | undefined) {
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const entry = pilotDirectory().find(entry => entry.row.login === login);
  const actual = createHash("sha256").update(key).digest();
  const expected = Buffer.from(entry?.row.keyHash || "0".repeat(64), "hex");
  return timingSafeEqual(actual, expected) && entry ? entry.user : null;
}
