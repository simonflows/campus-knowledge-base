import type { Metadata, Viewport } from "next";
import { version as appVersion } from "@/package.json";
import Link from "next/link";
import { ArrowUpRight, Database } from "lucide-react";
import "./globals.css";
import { BridgeProvider } from "@/components/bridge-provider";
import { UserMenu } from "@/components/auth/user-menu";
import { HeaderNav } from "@/components/navigation/header-nav";
import { CampusBrand } from "@/components/navigation/campus-brand";
import { PageContent } from "@/components/navigation/page-content";
import { AmbientBackdrop } from "@/components/motion/ambient-backdrop";
import { SystemStatusBar } from "@/components/system/system-status-bar";
import { Toaster } from "@/components/ui/sonner";
import { AssistantWidget } from "@/components/assistant/assistant-widget";
import { getIntegrationStatus } from "@/lib/integration-status";
import { getSessionUser } from "@/lib/auth-server";
import { universities } from "@/lib/data";
import { campusServices } from "@/lib/campus-services";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { countIncomingRequests } from "@/lib/information-requests-models";
import { getStorageMode } from "@/lib/db";
import { getLocalStoreReadProblem } from "@/lib/local-store";
import { getTrustedPreviewOrigin } from "@/lib/bridge/config";

const appName = "Справочник кампуса «Южный Урал»";
const description =
  "Карточки семи университетов-резидентов Челябинской области, паспорт кампуса, проверка фактов и редактор публикаций.";
export const metadata: Metadata = {
  title: appName,
  description,
  openGraph: { title: appName, description, type: "website", locale: "ru_RU" },
  other: { "page-type": "software", "site-kind": "software" },
};
export const viewport: Viewport = { themeColor: "#102332" };

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const assetBase = process.env.BASE_PATH || "";
  const previewOrigin = getTrustedPreviewOrigin(
    process.env.NODE_ENV,
    process.env.CAMPUS_PREVIEW_ORIGIN
  );
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
  const staff = Boolean(user && user.role !== "guest");
  const sections = campusServices(undefined, staff);
  return (
    <html
      suppressHydrationWarning
      lang="ru"
      data-type="software"
      data-ground="sky"
      data-radius="soft"
      data-buttons="solid"
      data-motion="auto"
      className="font-sans"
    >
      <head>
        <link rel="stylesheet" href={`${assetBase}/atlas/motion/motion.css`} />
      </head>
      <body className="flex min-h-screen flex-col antialiased">
        <AmbientBackdrop />
        <a className="skip atlas-skip" href="#main-content">
          Перейти к содержимому
        </a>
        {previewOrigin && (
          <BridgeProvider trustedOrigin={previewOrigin} basePath={assetBase} />
        )}
        <header className="nav atlas-header">
          <div className="wrap atlas-wrap atlas-header-row">
            <Link className="brand" href="/" aria-label={`${appName}, главная`}>
              <CampusBrand />
            </Link>
            <HeaderNav incomingCount={incomingCount} staff={staff} />
            <div className="atlas-controls">
              <SystemStatusBar
                showIntegrationStatus={
                  process.env.NODE_ENV !== "production" && demoLoginEnabled()
                }
                initialStatus={initialStatus}
                staff={staff}
              />
              <UserMenu initialUser={user} />
            </div>
          </div>
        </header>

        {storageMode !== "dynamodb" && (
          <div className="atlas-mode" role="status">
            <div className="wrap atlas-wrap">
              <Database size={14} aria-hidden="true" />
              <span>
                {localReadProblem
                  ? `${localReadProblem} Запись отключена.`
                  : storageMode === "local-json"
                    ? "Локальное демо. Совместная редактура и межвузовские запросы доступны с общей базой."
                    : storageMode === "static-export"
                      ? "Демонстрационные примеры. Сохранение отключено."
                      : "Общая база недоступна. Сохранение отключено."}
              </span>
            </div>
          </div>
        )}
        <PageContent>{children}</PageContent>
        <footer className="atlas-footer closing">
          <div className="wrap atlas-wrap">
            <div className="atlas-footer-grid">
              <div>
                <Link href="/">
                  <CampusBrand />
                </Link>
                <p>
                  Межуниверситетский кампус мирового уровня «Южный Урал»
                  <br />
                  Челябинская область
                </p>
              </div>
              <div>
                <h2>Разделы справочника</h2>
                <ul>
                  {sections.map(({ href, title }) => (
                    <li key={href}>
                      <Link href={href}>{title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Университеты-резиденты</h2>
                <ul>
                  {universities.map((u) => (
                    <li key={u.id}>
                      <Link
                        href={`/knowledge?folder=${encodeURIComponent(`01_universities/${u.id}`)}`}
                      >
                        {u.shortName}
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="atlas-copyright">
              <span>
                © {new Date().getFullYear()} {appName}
              </span>
              <span>Версия {appVersion} · г. Челябинск</span>
            </div>
          </div>
        </footer>
        <AssistantWidget staff={staff} />
        <Toaster richColors position="top-right" offset={{ top: 96 }} />
      </body>
    </html>
  );
}
