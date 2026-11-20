import { NextRequest, NextResponse } from "next/server";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ExternalHyperlink } from "docx";
import { getSessionUser } from "@/lib/auth-server";
import { getEditorial, getEditorialRevisions } from "@/lib/editorial-models";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  try {
    const doc = await getEditorial((await context.params).id, user);
    const revisionId =
      request.nextUrl.searchParams.get("revisionId") || doc.revisionId;
    const revision = (await getEditorialRevisions(doc, user)).find(
      (r) => r.id === revisionId
    );
    if (!revision)
      return NextResponse.json(
        { error: "Редакция не найдена" },
        { status: 404 }
      );
    const content = revision.content;
    const approval = doc.events.find(
      (event) => event.action === "approved" && event.revisionId === revision.id
    );
    const publicOrigin = new URL(process.env.CAMPUS_PUBLIC_ORIGIN || request.nextUrl.origin).origin;
    const children = [
      new Paragraph({
        text: content.title || "Без заголовка",
        heading: HeadingLevel.TITLE,
      }),
      new Paragraph({
        text: `${doc.channel} · ${approval ? "Редакция согласована" : "Редакция не согласована"} · редакция ${revision.number}`,
      }),
      new Paragraph({
        text: `Автор: ${doc.ownerName}. Сохранено: ${revision.createdAt}`,
      }),
      new Paragraph(content.lead),
      ...content.sections.flatMap((s) => [
        new Paragraph({
          text: s.heading,
          heading:
            s.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
        }),
        ...s.chunks.flatMap((c) =>
          c.content.split(/\n\n+/).map((p) => new Paragraph(p))
        ),
      ]),
      new Paragraph({
        text: "Источники: официальные данные / проверенные факты",
        heading: HeadingLevel.HEADING_2,
      }),
      ...content.sourceCardIds.map(
        (id, i) =>
          new Paragraph({
            children: [
              new ExternalHyperlink({
                link: new URL("/knowledge?card=" + encodeURIComponent(id) + "&version=approved", publicOrigin).href,
                children: [new TextRun({ text: `${i + 1}. ${content.sourceCardTitles[i] || id} — ID: ${id}`, style: "Hyperlink" })],
              }),
            ],
          })
      ),
      new Paragraph(`ID материала: ${doc.id}. ID редакции: ${revision.id}.`),
      new Paragraph(
        approval
          ? `Эта редакция согласована: ${approval.actorName}, ${approval.at}.`
          : "Эта редакция не имеет подтверждённого согласования."
      ),
    ];
    const buffer = await Packer.toBuffer(
      new Document({ sections: [{ children }] })
    );
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        ...privateHeaders,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="article-${doc.id}.docx"`,
      },
    });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
