import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { WorkWorkspace } from "@/components/work/work-workspace";
import { WorkspaceMasthead } from "@/components/workspace-masthead";
import { getSessionUser } from "@/lib/auth-server";
import { canUseStaffWorkflow } from "@/lib/auth";
import { normalizeWorkSection } from "@/components/work/work-state";

export const dynamic = "force-dynamic";

export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; record?: string; new?: string }>;
}) {
  const [user, params] = await Promise.all([getSessionUser(), searchParams]);
  if (!canUseStaffWorkflow(user)) {
    return (
      <div className="atlas-wrap campus-workspace">
        <WorkspaceMasthead id="work-title" title="Моя работа" icon={ClipboardList}
          description="Согласования, запросы и сверка источников для сотрудников кампуса." />
        <section className="desk-panel desk-locked">
          <div>
            <h2>Войдите как сотрудник</h2>
            <p className="desk-footnote">Рабочие задачи и материалы появятся после входа.</p>
            <Link href="/login" className="desk-text-link">Ко входу</Link>
          </div>
        </section>
      </div>
    );
  }
  const section = normalizeWorkSection(params.tab, user.role === "admin");
  const record = typeof params.record === "string" && params.record.length <= 100 ? params.record : undefined;
  return (
    <WorkWorkspace key={user.id} section={section} record={record} create={params.new === "1"}
      admin={user.role === "admin"} />
  );
}
