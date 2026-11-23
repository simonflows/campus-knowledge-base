import { NextRequest, NextResponse } from "next/server";

import { storageUnavailableMessage, unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildCanonicalRewrite,
  checkFactText,
  renderCanonicalRewrite,
  type FactCheckResult,
} from "@/lib/fact-check";
import {
  checkVerifiedRewrite,
  rewriteCanonWithAi,
  type RewriteAiReview,
} from "@/lib/canon-rewrite-ai";
import { getCardVersionId } from "@/lib/knowledge-versions";
import { getCanonicalKnowledgeCards } from "@/lib/models";
import { factCheckInputSchema } from "@/lib/validation/fact-check";
import { assistFactCheck, authorizeFlashAssist } from "@/lib/flash-assist";
import { mergeAiFactReview, reviewFactsWithAi } from "@/lib/canon-ai";
import { currentCanonSources } from "@/lib/canon-ai";
import type { KnowledgeCard } from "@/lib/knowledge";
import { JsonBodyError, readBoundedJson } from "@/lib/http-json";
import { acceptsFactCheckStream, streamFactCheck } from "@/lib/fact-check-stream";
import type { FactCheckProgress } from "@/lib/fact-check-progress";

function rewriteSummary(
  result: Pick<FactCheckResult, "summary" | "canPublish">
) {
  return {
    summary: result.summary,
    canPublish: result.canPublish,
    isClean: result.summary.red === 0 && result.summary.yellow === 0,
  };
}

function withSourceVersions(
  result: FactCheckResult,
  cards: KnowledgeCard[]
): FactCheckResult {
  const sources = new Map(
    currentCanonSources(cards).map((source) => [
      source.cardId,
      source.versionId,
    ])
  );
  return {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      ...(finding.sourceCardId &&
        sources.has(finding.sourceCardId) && {
          sourceVersionId: sources.get(finding.sourceCardId),
        }),
    })),
  };
}

async function runSemanticCheck(
  request: Request, accountId: string, text: string, cards: KnowledgeCard[],
  ordinary: FactCheckResult, onProgress?: (value: FactCheckProgress) => void
) {
  const ai = await reviewFactsWithAi({
    request, accountId, text, cards, ordinary,
    streaming: !!onProgress, onProgress,
  });
  const cancelled = () => ({ ok: false as const, status: 499, error: "Проверка отменена." });
  if (request.signal.aborted) return cancelled();
  if (ai.status === "ready") {
    const latest = await getCanonicalKnowledgeCards(request.signal).catch(() => null);
    if (request.signal.aborted) return cancelled();
    if (!latest) return { ok: false as const, status: 503, error: storageUnavailableMessage };
    const versions = new Map(currentCanonSources(latest).map(source => [source.cardId, source.versionId]));
    if (versions.size !== ai.sources.length ||
      ai.sources.some(source => versions.get(source.cardId) !== source.versionId)) {
      return {
        ok: true as const,
        result: {
          ...withSourceVersions(checkFactText(text, latest), latest),
          ai: { status: "failed" as const, reason: "sources-changed" as const },
        },
      };
    }
  }
  return { ok: true as const, result: { ...mergeAiFactReview(ordinary, ai), ai } };
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
  const account =
    useAi || (flashAssist && mode === "check")
      ? await authorizeFlashAssist(request)
      : null;
  if (account instanceof Response) return account;
  const cards = await getCanonicalKnowledgeCards(request.signal).catch(() => null);
  if (!cards) return unavailableStorageResponse();
  const result = withSourceVersions(checkFactText(text, cards), cards);

  if (mode === "check") {
    if (useAi && account) {
      if (acceptsFactCheckStream(request)) {
        return streamFactCheck(request, (scoped, progress) =>
          runSemanticCheck(scoped, account, text, cards, result, progress)
        );
      }
      const answer = await runSemanticCheck(request, account, text, cards, result);
      const headers = { "Cache-Control": "private, no-store", Vary: "Accept" };
      return NextResponse.json(
        answer.ok ? answer.result : { error: answer.error },
        { status: answer.ok ? 200 : answer.status, headers }
      );
    }
    return NextResponse.json(
      account
        ? {
            ...result,
            flashAssist: await assistFactCheck(request, account, text).catch(
              () => ({ status: "failed" })
            ),
          }
        : result,
      account ? { headers: { "Cache-Control": "no-store" } } : undefined
    );
  }

  let currentCards = cards;
  let originalResult = result;
  let rewrite = buildCanonicalRewrite(text, cards);
  let rewriteAi: RewriteAiReview & { reason?: "sources-changed" } = {
    status: "local",
  };
  let verifiedResult: Pick<FactCheckResult, "summary" | "canPublish"> | null =
    null;

  if (rewrite && useAi && account) {
    const basis = rewrite;
    const attempt = await rewriteCanonWithAi({
      request,
      accountId: account,
      original: text,
      rewrite,
      cards,
    });
    const { status, usage, usageComplete, attempts } = attempt;
    const metrics = { usage, usageComplete, attempts };
    const latest = await getCanonicalKnowledgeCards().catch(() => null);
    if (!latest) return unavailableStorageResponse();
    currentCards = latest;
    originalResult = withSourceVersions(checkFactText(text, latest), latest);
    rewrite = buildCanonicalRewrite(text, latest);

    const versions = new Map(
      latest.map((card) => [card.id, getCardVersionId(card)])
    );
    const previousVersions = new Map(
      cards.map((card) => [card.id, getCardVersionId(card)])
    );
    rewriteAi = { status: status === "ready" ? "failed" : status, ...metrics };
    if (
      !rewrite ||
      rewrite.plainText !== basis.plainText ||
      rewrite.sourceCardIds.length !== basis.sourceCardIds.length ||
      rewrite.sourceCardIds.some(
        (id, index) =>
          id !== basis.sourceCardIds[index] ||
          versions.get(id) !== previousVersions.get(id)
      ) ||
      (status === "ready" &&
        attempt.citations.some(
          (citation) => versions.get(citation.cardId) !== citation.versionId
        ))
    ) {
      rewriteAi = { status: "failed", reason: "sources-changed", ...metrics };
    } else if (status === "ready") {
      const proposed = renderCanonicalRewrite({
        ...rewrite,
        lead: attempt.lead,
      });
      const checked = checkVerifiedRewrite(
        proposed.plainText,
        attempt.sentences,
        latest
      );
      if (checked.canPublish) {
        rewrite = proposed;
        verifiedResult = checked;
        rewriteAi = {
          status: "ready",
          citations: attempt.citations,
          ...metrics,
        };
      }
    }
  }

  const rewriteResult =
    rewrite &&
    (verifiedResult ?? checkFactText(rewrite.plainText, currentCards));
  const rewriteSourceIds = new Set(rewrite?.sourceCardIds ?? []);

  return NextResponse.json(
    {
      ...originalResult,
      rewrite: rewrite && {
        ...rewrite,
        sourceVersions: Object.fromEntries(
          currentCanonSources(currentCards)
            .filter((source) => rewriteSourceIds.has(source.cardId))
            .map((source) => [source.cardId, source.versionId])
        ),
      },
      rewriteAi,
      rewriteCheck: rewriteResult && rewriteSummary(rewriteResult),
      ...(!rewrite && {
        rewriteError:
          "В утверждённых карточках недостаточно сведений по теме текста. Уточните название объекта или добавьте официальный источник к его карточке.",
      }),
    },
    account ? { headers: { "Cache-Control": "private, no-store" } } : undefined
  );
}
