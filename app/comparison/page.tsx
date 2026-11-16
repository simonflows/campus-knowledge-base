import { ComparisonWorkspace } from "@/components/comparison/comparison-workspace";
import { getAlibabaAiConfig } from "@/lib/alibaba-ai";
import { getStorageMode } from "@/lib/db";
import { getYandexAiConfig } from "@/lib/yandex-ai";

export const dynamic = "force-dynamic";

export default async function ComparisonPage() {
  const [storageMode, yandexCfg, alibabaCfg] = await Promise.all([
    getStorageMode(),
    Promise.resolve(getYandexAiConfig()),
    Promise.resolve(getAlibabaAiConfig()),
  ]);

  return (
    <ComparisonWorkspace
      yandexConfigured={yandexCfg.configured}
      alibabaConfigured={alibabaCfg.configured}
      storageMode={storageMode}
    />
  );
}
