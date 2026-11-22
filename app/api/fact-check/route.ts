import { NextRequest, NextResponse } from "next/server";

import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildCanonicalRewrite,
  checkFactText,
  renderCanonicalRewrite,
  type FactCheckResult,
} from "@/lib/fact-check";
import { checkVerifiedRewrite, rewriteCanonWithAi, type RewriteAiReview } from "@/lib/canon-rewrite-ai";
import { getCardVersionId } from "@/lib/knowledge-versions";
import { getCanonicalKnowledgeCards } from "@/lib/models";
import { factCheckInputSchema } from "@/lib/validation/fact-check";
import { assistFactCheck, authorizeFlashAssist } from "@/lib/flash-assist";
import { mergeAiFactReview, reviewFactsWithAi } from "@/lib/canon-ai";
import { currentCanonSources } from "@/lib/canon-ai";
import { JsonBodyError, readBoundedJson } from "@/lib/http-json";

function rewriteSummary(result: Pick<FactCheckResult, "summary" | "canPublish">) {
  return {
    summary: result.summary,
    canPublish: result.canPublish,
    isClean: result.summary.red === 0 && result.summary.yellow === 0,
  };
}

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await readBoundedJson(request, 256 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: error instanceof JsonBodyError ? error.status : 400 }
    );
  }

  const parsed = factCheckInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Проверьте текст и попробуйте снова",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { text, mode, flashAssist, useAi } = parsed.data;
  const account = useAi || (flashAssist && mode === "check") ? await authorizeFlashAssist(request) : null;
  if (account instanceof Response) return account;
  const cards = await getCanonicalKnowledgeCards().catch(() => null);
  if (!cards) return unavailableStorageResponse();
  const result = checkFactText(text, cards);

  if (mode === "check") {
    if (useAi && account) {
      const ai = await reviewFactsWithAi({ request, accountId: account, text, cards });
      if (ai.status === "ready") {
        const latest = await getCanonicalKnowledgeCards().catch(() => null);
        if (!latest) return unavailableStorageResponse();
        const versions = new Map(currentCanonSources(latest).map(source => [source.cardId, source.versionId]));
        if (ai.sources.some(source => versions.get(source.cardId) !== source.versionId)) {
          return NextResponse.json({ ...checkFactText(text, latest), ai: { status: "failed", reason: "sources-changed" } }, { headers: { "Cache-Control": "private, no-store" } });
        }
      }
      return NextResponse.json({ ...mergeAiFactReview(result, ai), ai }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json(
      account
        ? { ...result, flashAssist: await assistFactCheck(request, account, text).catch(() => ({ status: "failed" })) }
        : result,
      account ? { headers: { "Cache-Control": "no-store" } } : undefined,
    );
  }

  let currentCards = cards;
  let originalResult = result;
  let rewrite = buildCanonicalRewrite(text, cards);
  let rewriteAi: RewriteAiReview & { reason?: "sources-changed" } = { status: "local" };
  let verifiedResult: Pick<FactCheckResult, "summary" | "canPublish"> | null = null;

  if (rewrite && useAi && account) {
    const basis = rewrite;
    const attempt = await rewriteCanonWithAi({ request, accountId: account, original: text, rewrite, cards });
    const { status, usage, usageComplete, attempts } = attempt;
    const metrics = { usage, usageComplete, attempts };
    const latest = await getCanonicalKnowledgeCards().catch(() => null);
    if (!latest) return unavailableStorageResponse();
    currentCards = latest;
    originalResult = checkFactText(text, latest);
    rewrite = buildCanonicalRewrite(text, latest);

    const versions = new Map(latest.map(card => [card.id, getCardVersionId(card)]));
    const previousVersions = new Map(cards.map(card => [card.id, getCardVersionId(card)]));
    rewriteAi = { status: status === "ready" ? "failed" : status, ...metrics };
    if (!rewrite || rewrite.plainText !== basis.plainText ||
        rewrite.sourceCardIds.length !== basis.sourceCardIds.length ||
        rewrite.sourceCardIds.some((id, index) =>
          id !== basis.sourceCardIds[index] || versions.get(id) !== previousVersions.get(id)
        ) ||
        status === "ready" && attempt.citations.some(citation => versions.get(citation.cardId) !== citation.versionId)) {
      rewriteAi = { status: "failed", reason: "sources-changed", ...metrics };
    } else if (status === "ready") {
      const proposed = renderCanonicalRewrite({ ...rewrite, lead: attempt.lead });
      const checked = checkVerifiedRewrite(proposed.plainText, attempt.sentences, latest);
      if (checked.canPublish) {
        rewrite = proposed;
        verifiedResult = checked;
        rewriteAi = { status: "ready", citations: attempt.citations, ...metrics };
      }
    }
  }

  const rewriteResult = rewrite && (verifiedResult ?? checkFactText(rewrite.plainText, currentCards));

  return NextResponse.json({
    ...originalResult,
    rewrite,
    rewriteAi,
    rewriteCheck: rewriteResult && rewriteSummary(rewriteResult),
    ...(!rewrite && {
      rewriteError: "В утверждённых карточках недостаточно сведений по теме текста. Уточните название объекта или добавьте официальный источник к его карточке.",
    }),
  }, account ? { headers: { "Cache-Control": "private, no-store" } } : undefined);
}
