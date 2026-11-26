import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "./auth";
import { universities } from "./data";
import { accountEmailSchema, accountPublicIdSchema, accountProofSchema, accountSessionPattern, staffGrantSchema, type StaffGrant } from "./account-validation";

const SESSION_LIFETIME = 8 * 60 * 60;
const VERIFY_LIFETIME = 24 * 60 * 60;
const RESET_LIFETIME = 30 * 60;
const RESEND_DELAY = 60;

type TokenProof = { digest: string; expiresAt: number; sentAt: number };

export type AccountMessage = {
  email: string;
  purpose: "verify" | "reset";
  token: string;
};

export type AccountProvider = "password" | "yandex";
export type YandexAccountProfile = { subject: string; name: string; email?: string };

export type AccountIdentity = {
  id: string;
  userId: string;
  email?: string;
  authProvider?: "yandex";
  activatedAt?: number;
  revision: number;
  sessionEpoch: number;
  name?: string;
  passwordHash?: string;
  verifiedAt?: number;
  verification?: TokenProof;
  passwordReset?: TokenProof;
  expiresAt?: number;
  grant?: StaffGrant;
  grantSetAt?: number;
  grantSetBy?: string;
};

export type AccountSession = {
  id: string;
  identityId: string;
  sessionEpoch: number;
  expiresAt: number;
};

export type AccountRateBucket = { id: string; limit: number; expiresAt: number };

export interface AccountStore {
  readIdentity(id: string): Promise<AccountIdentity | undefined>;
  findIdentityId(userId: string): Promise<string | undefined>;
  putIdentity(account: AccountIdentity, previousRevision: number | null, mailBudget?: AccountRateBucket): Promise<boolean>;
  readSession(id: string): Promise<AccountSession | undefined>;
  putSession(session: AccountSession): Promise<void>;
  deleteSession(id: string): Promise<void>;
  consumeRate(buckets: AccountRateBucket[]): Promise<boolean>;
}

export class AccountError extends Error {
  constructor(message: string, public status: number, public retryAfter?: number) {
    super(message);
    this.name = "AccountError";
  }
}

function invalidLink() {
  return new AccountError("Срок действия ссылки истёк или она уже использована. Запросите новую.", 400);
}

function busy() {
  return new AccountError("Слишком много попыток. Повторите позже.", 429, 30);
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

function normalizedEmail(value: string) {
  const parsed = accountEmailSchema.safeParse(value);
  if (!parsed.success) throw new AccountError("Введите адрес электронной почты", 400);
  return parsed.data;
}

// OWASP scrypt profile N=2^15, r=8, p=3. Bound total KDF memory while
// sharing the process with Next.js and AI requests.
let activePasswordJobs = 0;
async function derivePassword(password: string, salt: Buffer) {
  if (activePasswordJobs >= 3) throw busy();
  activePasswordJobs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 },
        (error, result) => error ? reject(error) : resolve(result));
    });
  } finally {
    activePasswordJobs--;
  }
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return ["scrypt-v1", salt.toString("hex"), derived.toString("hex")].join("$");
}

async function matchesPassword(password: string, encoded?: string) {
  const parts = /^scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(encoded ?? "");
  const derived = await derivePassword(password, parts ? Buffer.from(parts[1], "hex") : Buffer.alloc(16));
  return !!parts && timingSafeEqual(derived, Buffer.from(parts[2], "hex"));
}

const organizations = {
  ministry: "Минобрнауки Челябинской области",
  rio: "АНО «РИОН»",
  chkk: "ООО «ЧКК»",
  author: "Независимый автор",
};

type AccountDirectoryIdentity = Pick<AccountIdentity, "userId" | "name" | "grant">;

export function accountUser(account: AccountDirectoryIdentity): SessionUser {
  const grant = account.grant ?? { role: "author" };
  const universityId = "universityId" in grant ? grant.universityId : undefined;
  const organization = "universityId" in grant
    ? universities.find(university => university.id === grant.universityId)!.shortName
    : organizations[grant.role];
  const name = account.name ?? "Автор";
  return {
    id: account.userId,
    name,
    role: grant.role,
    organization,
    position: organization,
    ...(universityId ? { universityId } : {}),
    ownershipLabel: name + ", " + organization,
    // A newly granted role does not prove that this person owns a legacy card.
    ownerAliases: [],
    organizationAliases: [],
  };
}

function isVerified(account?: AccountIdentity): account is AccountIdentity & {
  name: string;
  passwordHash: string;
  verifiedAt: number;
} {
  return Boolean(account?.authProvider !== "yandex" && account?.verifiedAt != null && account.passwordHash && account.name);
}

function isYandexAccount(account?: AccountIdentity): account is AccountIdentity & { name: string; activatedAt: number } {
  return Boolean(account?.authProvider === "yandex" && account.activatedAt != null && account.name);
}

function isActiveAccount(account?: AccountIdentity): account is AccountIdentity & { name: string } {
  return isVerified(account) || isYandexAccount(account);
}

function accountProvider(account: AccountIdentity): AccountProvider {
  return account.authProvider ?? "password";
}

function validProof(proof: TokenProof | undefined, token: string, now: number) {
  return Boolean(proof && proof.expiresAt > now && timingSafeEqual(
    Buffer.from(proof.digest, "hex"),
    Buffer.from(digest(token), "hex"),
  ));
}

async function readStorage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch {
    throw new AccountError("Хранилище учётных записей временно недоступно.", 503);
  }
}

type RateAction = "signup" | "reset-mail" | "login" | "proof" | "grant";
const rates: Record<RateAction, { seconds: number; total: number; address: number; email: number }> = {
  signup: { seconds: 3600, total: 2400, address: 12, email: 4 },
  "reset-mail": { seconds: 3600, total: 2400, address: 12, email: 4 },
  login: { seconds: 300, total: 400, address: 45, email: 12 },
  proof: { seconds: 900, total: 300, address: 24, email: 12 },
  grant: { seconds: 60, total: 40, address: 20, email: 20 },
};

export function createAccountService(
  store: AccountStore,
  clock: () => number,
  send: (message: AccountMessage) => Promise<void>,
) {
  async function consume(action: RateAction, target: string, address?: string | null) {
    const rate = rates[action];
    const window = Math.floor(clock() / rate.seconds);
    const end = (window + 1) * rate.seconds;
    const prefix = [action, window].join(":");
    const buckets: AccountRateBucket[] = [
      { id: prefix, limit: rate.total, expiresAt: end + rate.seconds },
      { id: prefix + ":target:" + digest(target), limit: rate.email, expiresAt: end + rate.seconds },
    ];
    if (address) buckets.push({ id: prefix + ":ip:" + digest(address), limit: rate.address, expiresAt: end + rate.seconds });
    if (!(await readStorage(store.consumeRate(buckets)))) {
      throw new AccountError("Слишком много попыток. Повторите позже.", 429, Math.max(1, end - clock()));
    }
  }

  async function start(emailInput: string, purpose: AccountMessage["purpose"], address?: string | null) {
    const email = normalizedEmail(emailInput);
    await consume(purpose === "verify" ? "signup" : "reset-mail", email, address);
    const id = digest(email);
    const current = await readStorage(store.readIdentity(id));
    const now = clock();
    const verification = purpose === "verify";
    if (verification ? isVerified(current) : !isVerified(current)) return;
    const prior = verification ? current?.verification : current?.passwordReset;
    if (prior && now - prior.sentAt < RESEND_DELAY) return;
    const nonce = newToken();
    const proof = { digest: digest(nonce), sentAt: now, expiresAt: now + (verification ? VERIFY_LIFETIME : RESET_LIFETIME) };
    const account: AccountIdentity = {
      ...(current ?? { id, userId: "author-" + randomUUID(), email, sessionEpoch: 0 }),
      revision: (current?.revision ?? -1) + 1,
      ...(verification ? { verification: proof, expiresAt: proof.expiresAt } : { passwordReset: proof }),
    };
    const day = Math.floor(now / 86400);
    const mailBudget = { id: "mail-day:" + day, limit: 150, expiresAt: (day + 2) * 86400 };
    if (!(await readStorage(store.putIdentity(account, current?.revision ?? null, mailBudget)))) return;
    await send({ email, purpose, token: id + "." + nonce });
  }

  async function finish(
    purpose: AccountMessage["purpose"],
    token: string,
    password: string,
    name?: string,
    address?: string | null,
  ) {
    if (!accountProofSchema.safeParse(token).success) throw invalidLink();
    const [id, nonce] = token.split(".");
    // Keep the target bucket scoped to this secret proof, rather than the account ID.
    await consume("proof", token, address);
    const current = await readStorage(store.readIdentity(id));
    const verification = purpose === "verify";
    if (!current || (verification ? isVerified(current) : !isVerified(current))) throw invalidLink();
    const proof = verification ? current.verification : current.passwordReset;
    if (!validProof(proof, nonce, clock())) throw invalidLink();
    const passwordHash = await hashPassword(password);
    const now = clock();
    if (!validProof(proof, nonce, now)) throw invalidLink();
    const next: AccountIdentity = {
      ...current,
      revision: current.revision + 1,
      sessionEpoch: current.sessionEpoch + 1,
      passwordHash,
    };
    if (verification) {
      next.verifiedAt = now;
      next.name = name;
      delete next.verification;
      delete next.expiresAt;
    } else {
      delete next.passwordReset;
    }
    if (!(await readStorage(store.putIdentity(next, current.revision)))) throw invalidLink();
  }

  async function openSession(account: AccountIdentity) {
    const token = "v3." + newToken();
    const session: AccountSession = {
      id: digest(token),
      identityId: account.id,
      sessionEpoch: account.sessionEpoch,
      expiresAt: clock() + SESSION_LIFETIME,
    };
    await readStorage(store.putSession(session));
    return { token, user: accountUser(account) };
  }

  async function findGrantAccount(actor: SessionUser, userId: string, address?: string | null) {
    if (actor.role !== "admin") throw new AccountError("Назначать роли может координатор.", 403);
    if (!accountPublicIdSchema.safeParse(userId).success) throw new AccountError("Укажите код аккаунта.", 400);
    await consume("grant", userId, address);
    const identityId = await readStorage(store.findIdentityId(userId));
    const account = identityId && await readStorage(store.readIdentity(identityId));
    if (!account || !isActiveAccount(account) || account.userId !== userId)
      throw new AccountError("Аккаунт не найден.", 404);
    return account;
  }

  async function saveRole(actor: SessionUser, account: AccountIdentity, input: unknown) {
    const parsed = staffGrantSchema.safeParse(input);
    if (!parsed.success) throw new AccountError("Проверьте выбранную роль и вуз.", 400);
    const next = {
      ...account,
      revision: account.revision + 1,
      sessionEpoch: account.sessionEpoch + 1,
      grant: parsed.data,
      grantSetAt: clock(),
      grantSetBy: actor.id,
    };
    if (!(await readStorage(store.putIdentity(next, account.revision))))
      throw new AccountError("Данные аккаунта изменились. Найдите его снова.", 409);
    return accountUser(next);
  }

  return {
    startSignup: (email: string, address?: string | null) => start(email, "verify", address),
    startReset: (email: string, address?: string | null) => start(email, "reset", address),
    finishSignup: (token: string, { name, password }: { name: string; password: string }, address?: string | null) =>
      finish("verify", token, password, name, address),
    finishReset: (token: string, password: string, address?: string | null) =>
      finish("reset", token, password, undefined, address),

    async login(emailInput: string, password: string, address?: string | null) {
      const email = normalizedEmail(emailInput);
      await consume("login", email, address);
      const account = await readStorage(store.readIdentity(digest(email)));
      const verified = isVerified(account);
      const matched = await matchesPassword(password, verified ? account.passwordHash : undefined);
      if (!verified || !matched) throw new AccountError("Проверьте адрес, пароль и подтверждение почты.", 401);
      return openSession(account);
    },

    async consumeYandexFlow(state: string, expiresAt: number, address?: string | null) {
      const now = clock();
      if (expiresAt <= now) return false;
      const window = Math.floor(now / 300);
      const prefix = "oauth:yandex:" + window;
      const buckets = [
        { id: "oauth:yandex:flow:" + digest(state), limit: 1, expiresAt },
        { id: prefix, limit: 800, expiresAt: (window + 2) * 300 },
      ];
      if (address) buckets.push({ id: prefix + ":ip:" + digest(address), limit: 15, expiresAt: (window + 2) * 300 });
      return readStorage(store.consumeRate(buckets));
    },

    async loginYandex(profile: YandexAccountProfile) {
      const id = digest("yandex:" + profile.subject);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await readStorage(store.readIdentity(id));
        if (current && !isYandexAccount(current)) throw new AccountError("Вход через Яндекс временно недоступен.", 503);
        if (current?.name === profile.name && current.email === profile.email) return openSession(current);
        const account: AccountIdentity = {
          ...(current ?? { id, userId: "author-" + randomUUID(), sessionEpoch: 0, activatedAt: clock() }),
          authProvider: "yandex",
          name: profile.name,
          revision: (current?.revision ?? -1) + 1,
        };
        if (profile.email) account.email = profile.email;
        else delete account.email;
        if (await readStorage(store.putIdentity(account, current?.revision ?? null))) return openSession(account);
      }
      throw new AccountError("Аккаунт изменился. Повторите вход.", 409);
    },

    async resolveSession(token: string, providers: readonly AccountProvider[] = ["password", "yandex"]) {
      if (!accountSessionPattern.test(token)) return null;
      const session = await readStorage(store.readSession(digest(token)));
      if (!session || session.expiresAt <= clock()) return null;
      const account = await readStorage(store.readIdentity(session.identityId));
      if (!isActiveAccount(account) || account.sessionEpoch !== session.sessionEpoch || !providers.includes(accountProvider(account))) return null;
      return accountUser(account);
    },

    async logout(token: string) {
      if (accountSessionPattern.test(token)) await readStorage(store.deleteSession(digest(token)));
    },

    async findForGrant(actor: SessionUser, id: string, address?: string | null) {
      const account = await findGrantAccount(actor, id, address);
      return {
        id: account.userId, name: account.name, email: account.email, provider: accountProvider(account),
        grant: account.grant ?? { role: "author" as const }, revision: account.revision,
      };
    },

    async grantRoleById(actor: SessionUser, id: string, revision: number, input: unknown, address?: string | null) {
      const account = await findGrantAccount(actor, id, address);
      if (account.revision !== revision)
        throw new AccountError("Данные аккаунта изменились. Найдите его снова.", 409);
      return saveRole(actor, account, input);
    },
  };
}
