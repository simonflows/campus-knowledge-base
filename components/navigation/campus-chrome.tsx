import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { ReleaseNotes } from "@/components/navigation/release-notes";
import { CampusBrand } from "@/components/navigation/campus-brand";
import { CampusHeader } from "@/components/navigation/campus-header";
import { HeaderNav } from "@/components/navigation/header-nav";
import { PageContent } from "@/components/navigation/page-content";
import { AppLink } from "@/components/navigation/workspace-navigation";
import {
  SystemStatusBar,
  type SystemStatusPayload,
} from "@/components/system/system-status-bar";
import { AssistantWidget } from "@/components/assistant/assistant-widget";
import { universities } from "@/lib/data";
import { campusServices } from "@/lib/campus-services";
import { cn } from "@/lib/utils";

export const appName = "Справочник кампуса «Южный Урал»";

export function CampusChrome({
  staff,
  author = false,
  status,
  showIntegrationStatus = false,
  account,
  banner,
  children,
  demo = false,
}: {
  staff: boolean;
  author?: boolean;
  status: SystemStatusPayload;
  showIntegrationStatus?: boolean;
  account: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
  demo?: boolean;
}) {
  const sections = campusServices(demo ? false : undefined, staff, author);
  return (
    <>
      <AppLink className="skip atlas-skip" href="#main-content">
        Перейти к содержимому
      </AppLink>
      <CampusHeader className={cn("nav atlas-header", demo && "atlas-header--demo")}>
        <div className="wrap atlas-wrap atlas-header-row">
          <AppLink
            className="brand"
            href="/"
            aria-label={`${appName}, главная`}
          >
            <CampusBrand />
          </AppLink>
          <HeaderNav incomingCount={status.incomingRequests} staff={staff} author={author} />
          <div className="atlas-controls">
            <SystemStatusBar
              showIntegrationStatus={showIntegrationStatus}
              initialStatus={status}
              staff={staff}
              author={author}
            />
            {account}
          </div>
        </div>
      </CampusHeader>
      {banner}
      <PageContent>{children}</PageContent>
      <footer className="atlas-footer closing">
        <div className="wrap atlas-wrap">
          <div className="atlas-footer-grid">
            <div>
              <AppLink href="/">
                <CampusBrand />
              </AppLink>
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
                    <AppLink href={href}>{title}</AppLink>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2>Университеты-резиденты</h2>
              <ul>
                {universities.map((u) => (
                  <li key={u.id}>
                    <AppLink
                      href={`/knowledge?folder=${encodeURIComponent(`01_universities/${u.id}`)}`}
                    >
                      {u.shortName}
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </AppLink>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="atlas-copyright">
            <span>
              © {new Date().getFullYear()} {appName}
            </span>
            <span className="inline-flex items-center gap-2">
              <ReleaseNotes />
              <span>· г. Челябинск</span>
            </span>
          </div>
        </div>
      </footer>
      <AssistantWidget staff={staff || author} />
    </>
  );
}
