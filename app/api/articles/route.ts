import { NextResponse } from "next/server";
import { publicArticle } from "@/lib/articles";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { getAllArticles } from "@/lib/models";
export async function GET() {
  try {
    return NextResponse.json((await getAllArticles()).map(publicArticle), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return unavailableStorageResponse();
  }
}
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Сохраните личный черновик в редакторе и отправьте конкретную редакцию на согласование",
    },
    { status: 409 }
  );
}
export async function DELETE() {
  return NextResponse.json(
    {
      error:
        "Готовая публикация сохраняет историю согласования. Изменения проходят через новую редакцию черновика",
    },
    { status: 409 }
  );
}
