import { LoginScreen } from "@/components/auth/login-screen";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { getSessionUser } from "@/lib/auth-server";
import { emailAccountsEnabled } from "@/lib/account-directory";
import { accountReturnPath } from "@/lib/account-validation";
import { yandexOAuthConfig } from "@/lib/yandex-oauth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string; account?: string; oauth?: string }> }) {
  const [user, query] = await Promise.all([getSessionUser(), searchParams]);
  const returnTo = accountReturnPath(query.next);

  const basePath = process.env.BASE_PATH || "";
  const accountMode = query.account === "verify" || query.account === "reset" ? query.account : "login";
  return (
    <LoginScreen
      currentUser={user}
      demo={demoLoginEnabled()}
      returnTo={returnTo}
      staffRequired={query.reason === "staff"}
      emailEnabled={emailAccountsEnabled()}
      yandexEnabled={Boolean(yandexOAuthConfig())}
      oauthStatus={query.oauth === "invalid" || query.oauth === "cancelled" ? query.oauth : undefined}
      accountMode={accountMode}
      basePath={basePath}
    />
  );
}
