import type { FactCheckResult } from "@/lib/fact-check";

type CoverageResult = FactCheckResult & {
  claimCoverage?: {
    mode: "limited" | "semantic" | "mixed";
    supported: number;
    contradicted: number;
    unknown: number;
    opinion: number;
    outside: number;
    semanticReviewed?: number;
    spanCount?: number;
  };
  claims?: Array<{
    id: string;
    quote: string;
    verdict: "supported" | "contradicted" | "unknown" | "opinion" | "outside";
  }>;
};

export function FactCoverage({ result }: { result: CoverageResult }) {
  const counts = result.claimCoverage;
  const mode = counts?.mode ?? "limited";
  const supported = counts?.supported ?? result.summary.green;
  const contradicted = counts?.contradicted ?? result.summary.red;
  const unknown = counts?.unknown ?? result.summary.yellow;
  const excluded = (result.claims ?? []).filter(
    ({ verdict }) => verdict === "opinion" || verdict === "outside"
  );

  return (
    <section
      aria-label="Охват проверки"
      className="flex flex-col gap-3 border-t pt-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Охват проверки</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {mode === "semantic"
            ? "Смысловая проверка по утверждённым карточкам."
            : mode === "mixed"
              ? "Частичная смысловая проверка. Для остальных фрагментов применены правила."
              : "Ограниченная проверка по правилам. Смысловой разбор нейросетью не выполнен."}
        </p>
      </div>
      {mode === "mixed" &&
        counts?.semanticReviewed !== undefined &&
        counts.spanCount !== undefined && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Полностью разобрано нейросетью: {counts.semanticReviewed} из{" "}
            {counts.spanCount} фрагментов. Остальные обработаны по правилам; это
            не полная смысловая проверка статьи.
          </p>
        )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        {[
          ["Подтверждено", supported],
          ["Противоречия", contradicted],
          ["Недостаточно данных", unknown],
          ["Мнения и вопросы", counts?.opinion],
          ["За пределами базы", counts?.outside],
        ].map(([label, value]) =>
          value === undefined ? null : (
            <div key={label} className="flex flex-col gap-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-base font-semibold tabular-nums">{value}</dd>
            </div>
          )
        )}
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {supported + contradicted + unknown === 0
          ? "Подходящих фактов для сверки не найдено. Это не подтверждает весь текст."
          : "Результат относится к выделенным фактам и не подтверждает весь текст. Мнения и сведения вне базы не считаются ошибками."}
      </p>
      {excluded.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            Что не требует сверки · {excluded.length}
          </summary>
          <ul className="mt-2 flex max-h-64 flex-col gap-3 overflow-y-auto pr-2">
            {excluded.map(({ id, quote, verdict }) => (
              <li
                key={id}
                className="flex flex-col gap-1 [overflow-wrap:anywhere]"
              >
                <span className="text-muted-foreground">
                  {verdict === "opinion"
                    ? "Мнение, формулировка или вопрос"
                    : "За пределами базы"}
                </span>
                <q>{quote}</q>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
