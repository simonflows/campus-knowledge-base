import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth-server";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { publicArticle } from "@/lib/articles";
import { getArticleById } from "@/lib/models";
import { listLegacyArticles } from "@/lib/editorial-models";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const article = await getArticleById(id);
    if (article) return NextResponse.json(publicArticle(article), { headers });
    const legacy = (await listLegacyArticles(await getSessionUser())).find((a) => a.id === id);
    return legacy
      ? NextResponse.json({
          ...legacy,
          legacy: true,
          approvalStatus: "Статус согласования неизвестен",
        }, { headers })
      : NextResponse.json({ error: "Статья не найдена" }, { status: 404, headers });
  } catch {
    return unavailableStorageResponse();
  }
}
export async function PUT() {
  return NextResponse.json(
    {
      error:
        "Создайте новую редакцию в «Мои черновики». Изменения публикации требуют согласования",
    },
    { status: 409 }
  );
}
export async function DELETE() {
  return NextResponse.json(
    { error: "История согласованной публикации защищена" },
    { status: 409 }
  );
}
