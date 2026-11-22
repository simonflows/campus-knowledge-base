import "../data-workspaces.css";

import { ComparisonWorkspace } from "@/components/comparison/comparison-workspace";
import { isAlibabaAiConfigured } from "@/lib/alibaba-ai";
import { getSessionUser, isAdminPinRequired } from "@/lib/auth-server";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { getComparisonStorageMode } from "@/lib/deploy-storage";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { isYandexAiConfigured } from "@/lib/yandex-ai";

export const dynamic = "force-dynamic";

export default async function ComparisonPage() {
  const [storageMode, user] = await Promise.all([
    getComparisonStorageMode(),
    getSessionUser(),
  ]);

  if (!storageMode) return <StorageUnavailable title="Сравнение платформ" />;

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
