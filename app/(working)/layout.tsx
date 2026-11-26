import { Database } from "lucide-react";
import { UserMenu } from "@/components/auth/user-menu";
import { CampusChrome } from "@/components/navigation/campus-chrome";
import { BridgeProvider } from "@/components/bridge-provider";
import { getIntegrationStatus } from "@/lib/integration-status";
import { getSessionUser } from "@/lib/auth-server";
import { canUseStaffWorkflow } from "@/lib/auth";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { countIncomingRequests } from "@/lib/information-requests-models";
import { getStorageMode } from "@/lib/db";
import { getLocalStoreReadProblem } from "@/lib/local-store";
import { getTrustedPreviewOrigin } from "@/lib/bridge/config";

export default async function WorkingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, storageMode] = await Promise.all([
    getSessionUser(),
    getStorageMode(),
  ]);
  const localReadProblem =
    process.env.CAMPUS_LOCAL_DEMO === "true" &&
    process.env.NODE_ENV !== "production"
      ? await getLocalStoreReadProblem()
      : null;
  let incomingCount = 0;
  if (user?.universityId && storageMode === "dynamodb") {
    try {
      incomingCount = await countIncomingRequests(user);
    } catch {
      /* The requests table may still be waiting for migration. */
    }
  }
  const initialStatus = {
    incomingRequests: incomingCount,
    storageMode,
    ...getIntegrationStatus(),
  };
  const staff = canUseStaffWorkflow(user);
  const storageMessage = localReadProblem
    ? `${localReadProblem} Запись отключена.`
    : storageMode === "local-json"
      ? "Локальное демо. Совместная редактура и межвузовские запросы доступны с общей базой."
      : storageMode === "static-export"
        ? "Демонстрационные примеры. Сохранение отключено."
        : "Общая база недоступна. Сохранение отключено.";
  const basePath = process.env.BASE_PATH || "";
  const previewOrigin = getTrustedPreviewOrigin(
    process.env.NODE_ENV,
    process.env.CAMPUS_PREVIEW_ORIGIN
  );
  return (
    <>
      {previewOrigin && (
        <BridgeProvider trustedOrigin={previewOrigin} basePath={basePath} />
      )}
      <CampusChrome
        staff={staff}
        author={user?.role === "author"}
        status={initialStatus}
        showIntegrationStatus={
          process.env.NODE_ENV !== "production" && demoLoginEnabled()
        }
        account={<UserMenu initialUser={user} />}
        banner={
          storageMode !== "dynamodb" ? (
            <div className="atlas-mode" role="status">
              <div className="wrap atlas-wrap">
                <Database size={14} aria-hidden="true" />
                <span>{storageMessage}</span>
              </div>
            </div>
          ) : null
        }
      >
        {children}
      </CampusChrome>
    </>
  );
}
