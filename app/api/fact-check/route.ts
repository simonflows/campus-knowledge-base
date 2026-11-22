import { NextRequest, NextResponse } from "next/server";

import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildCanonicalRewrite,
  checkFactText,
  type FactCheckResult,
} from "@/lib/fact-check";
import { getCanonicalKnowledgeCards } from "@/lib/models";
import { factCheckInputSchema } from "@/lib/validation/fact-check";
import { assistFactCheck, authorizeFlashAssist } from "@/lib/flash-assist";

function rewriteSummary(result: FactCheckResult | null) {
  if (!result) return null;

  return {
    summary: result.summary,
    canPublish: result.canPublish,
    isClean: result.summary.red === 0 && result.summary.yellow === 0,
  };
}

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
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

  const { text, mode, flashAssist } = parsed.data;
  const account = flashAssist && mode === "check" ? await authorizeFlashAssist(request) : null;
  if (account instanceof Response) return account;
  const cards = await getCanonicalKnowledgeCards().catch(() => null);
  if (!cards) return unavailableStorageResponse();
  const result = checkFactText(text, cards);

  if (mode === "check") {
    return NextResponse.json(
      account ? { ...result, flashAssist: await assistFactCheck(request, account, text) } : result,
      account ? { headers: { "Cache-Control": "no-store" } } : undefined,
    );
  }

  const rewrite = buildCanonicalRewrite(text, cards);

  if (!rewrite) {
    return NextResponse.json(
      {
        ...result,
        rewrite: null,
        rewriteCheck: null,
        rewriteError:
          "В канонических карточках нет опоры для переписывания этого текста. Добавьте карточку проекта, лаборатории или кампуса и повторите проверку.",
      },
      { status: 200 }
    );
  }

  const rewriteResult = checkFactText(rewrite.plainText, cards);

  return NextResponse.json({
    ...result,
    rewrite,
    rewriteCheck: rewriteSummary(rewriteResult),
  });
}
