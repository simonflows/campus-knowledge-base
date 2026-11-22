import { LoginScreen } from "@/components/auth/login-screen";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { getSessionUser } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const [user, query] = await Promise.all([getSessionUser(), searchParams]);
  const returnTo = ["/analytics", "/editor", "/work", "/requests", "/check"].includes(query.next ?? "") ? query.next! : "/knowledge";

  return <LoginScreen currentUser={user} demo={demoLoginEnabled()} returnTo={returnTo} staffRequired={query.reason === "staff"} />;
}
