import { isAlibabaAiConfigured } from "./alibaba-ai";
import { isYandexAiConfigured } from "./yandex-ai";
import { isYandexDiskConfigured } from "./yandex-disk";

export function getIntegrationStatus() {
  return {
    yandexAi: { configured: isYandexAiConfigured() },
    alibabaAi: { configured: isAlibabaAiConfigured() },
    yandexDisk: { configured: isYandexDiskConfigured() },
  };
}
