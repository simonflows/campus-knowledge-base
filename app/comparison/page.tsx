import "../data-workspaces.css";

import { ComparisonWorkspace } from "@/components/comparison/comparison-workspace";
import { isAlibabaAiConfigured } from "@/lib/alibaba-ai";
import { getSessionUser, isAdminPinRequired } from "@/lib/auth-server";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { getStorageMode } from "@/lib/db";
import { isYandexAiConfigured } from "@/lib/yandex-ai";

export const dynamic = "force-dynamic";

export default async function ComparisonPage() {
  const [storageMode, user] = await Promise.all([
    getStorageMode(),
    getSessionUser(),
  ]);

  return (
    <ComparisonWorkspace
      yandexConfigured={isYandexAiConfigured()}
      alibabaConfigured={isAlibabaAiConfigured()}
      storageMode={storageMode}
      canRunLive={
        user?.role === "admin" && (!demoLoginEnabled() || isAdminPinRequired())
      }
    />
  );
}
