import { LoginScreen } from "@/components/auth/login-screen";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { getSessionUser } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getSessionUser();

  return <LoginScreen currentUser={user} demo={demoLoginEnabled()} />;
}
