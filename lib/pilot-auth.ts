import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { demoAccounts, getDemoAccount, normalizeOwnerLabel, toSessionUser, type SessionUser } from "./auth";

export function demoLoginEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.CAMPUS_DEMO_LOGIN === "true";
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
    // Count distinct identities, including inactive legacy profiles that still occur on cards.
    const claims = new Map<string, Map<string, Set<string>>>();
    const universityOwnerCounts = new Map<string, number>();
    function registerName(name: string, organization: string, id: string) {
      const label = normalizeOwnerLabel(name);
      const organizations = claims.get(label) ?? new Map<string, Set<string>>();
      const members = organizations.get(organization) ?? new Set<string>();
      members.add(id);
      organizations.set(organization, members);
      claims.set(label, organizations);
    }
    for (const profile of demoAccounts) {
      const members = rows.filter(row => row.profile === profile.id);
      const ids = members.length ? members.map(row => "pilot-" + row.login) : [profile.id];
      for (const name of profile.ownerAliases) {
        for (const id of ids) registerName(name, profile.organization, id);
      }
      for (const label of profile.organizationAliases) {
        registerName(label, profile.organization, "organization:" + profile.organization);
      }
    }
    for (const row of rows) {
      const profile = getDemoAccount(row.profile)!;
      if (profile.ownerAliases.length) registerName(row.name, profile.organization, "pilot-" + row.login);
      if (profile.role === "university_owner" && profile.universityId) {
        const count = universityOwnerCounts.get(profile.universityId) ?? 0;
        universityOwnerCounts.set(profile.universityId, count + 1);
      }
    }
    return rows.map(row => {
      const profile = toSessionUser(getDemoAccount(row.profile)!);
      const names = profile.ownerAliases.length ? new Set([...profile.ownerAliases, row.name]) : [];
      const ownerAliases: string[] = [];
      for (const name of names) {
        const organizations = claims.get(normalizeOwnerLabel(name))!;
        if (organizations.get(profile.organization)?.size === 1) {
          ownerAliases.push(organizations.size === 1 && !name.includes(",") ? name : name + ", " + profile.organization);
        }
      }
      const user: SessionUser = {
        ...profile,
        id: "pilot-" + row.login,
        name: row.name,
        ownershipLabel: row.name + ", " + profile.organization,
        ownerAliases,
        soleUniversityOwner: profile.role === "university_owner" &&
          !!profile.universityId && universityOwnerCounts.get(profile.universityId) === 1,
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
