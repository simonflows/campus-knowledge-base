import type { RewriteCheck } from "@/lib/fact-report";

export function RewriteCheckSummary({ check }: { check: RewriteCheck }) {
  return (
    <span
      className="block space-y-1 text-xs"
      aria-label="Проверка новой редакции"
    >
      <span className="block font-medium">
        {check.isClean && check.summary.green > 0
          ? "Распознанные факты новой редакции проверены"
          : "Новая редакция требует сверки"}
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        <span>Красных: {check.summary.red}</span>
        <span>Жёлтых: {check.summary.yellow}</span>
        <span className="font-medium text-emerald-800 dark:text-emerald-300">
          Зелёных: {check.summary.green}
        </span>
      </span>
    </span>
  );
}
