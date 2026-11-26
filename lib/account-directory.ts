import { cache } from "react";
import { AccountError, type AccountProvider } from "./account-service";
import { listAccountStaff } from "./account-storage";
import { demoLoginEnabled, sessionDirectory } from "./pilot-auth";

function canUseAccounts() {
  return process.env.OUTPUT_MODE !== "export" && process.env.USE_DATABASE !== "false" &&
    !(process.env.NODE_ENV !== "production" && process.env.CAMPUS_LOCAL_DEMO === "true") &&
    !demoLoginEnabled();
}

export function emailAccountsEnabled() {
  return canUseAccounts() && process.env.CAMPUS_EMAIL_ACCOUNTS_ENABLED === "true";
}

export function yandexAccountsEnabled() {
  return canUseAccounts() && process.env.CAMPUS_YANDEX_OAUTH_ENABLED === "true";
}

export function enabledAccountProviders(): AccountProvider[] {
  const providers: AccountProvider[] = [];
  if (emailAccountsEnabled()) providers.push("password");
  if (yandexAccountsEnabled()) providers.push("yandex");
  return providers;
}

export const staffDirectory = cache(async function staffDirectory() {
  const legacy = sessionDirectory();
  const providers = enabledAccountProviders();
  if (!providers.length) return legacy;
  try {
    return [...legacy, ...(await listAccountStaff(providers))];
  } catch {
    throw new AccountError("Каталог сотрудников временно недоступен.", 503);
  }
});
