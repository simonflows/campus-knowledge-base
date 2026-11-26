import { getSessionUser } from "@/lib/auth-server";
import { canUseStaffWorkflow } from "@/lib/auth";
import { getStorageMode } from "@/lib/db";
import { listInformationRequests } from "@/lib/information-requests-models";
import { mockInformationRequests } from "@/lib/information-requests";
import { RequestsWorkspace } from "@/components/requests/requests-workspace";
import { StorageUnavailable } from "@/components/storage-unavailable";
export const dynamic = "force-dynamic";
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; card?: string; request?: string }>;
}) {
  const [user, params] = await Promise.all([getSessionUser(), searchParams]);
  let items = mockInformationRequests;
  let available = false;
  if (canUseStaffWorkflow(user)) {
    const mode = await getStorageMode();
    if (mode === "read-only") return <StorageUnavailable title="Межвузовские запросы" />;
    if (mode === "dynamodb") {
      try {
        items = await listInformationRequests(user);
        available = true;
      } catch {
        return <StorageUnavailable title="Межвузовские запросы" />;
      }
    }
  }
  return (
    <RequestsWorkspace
      key={user?.id ?? "anonymous"}
      initialItems={items}
      user={user}
      available={available}
      initialQuestion={params.q ?? ""}
      initialCardId={params.card ?? null}
      initialRequestId={params.request?.slice(0, 200)}
    />
  );
}
