module.exports = async function runRequestBrowserChecks(page, credentials) {
  const location = new URL(page.url());
  const base = location.origin;
  const marker = location.hash.slice(1);
  if (!["http://localhost:8080", "http://127.0.0.1:8080", "http://127.0.0.2:8080"].includes(base) || !/^qa-marker-[0-9a-f-]{36}$/.test(marker)) throw new Error("Open the isolated fixture with its QA marker in the URL fragment first");
  const probe = await page.request.get(base + "/api/articles/" + marker, { maxRedirects: 0 });
  if (probe.status() !== 200 || (await probe.json()).title !== "Disposable QA " + marker) throw new Error("Server does not point at the marked fixture");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const make = async (accountId) => {
    const context = await page.context().browser().newContext();
    const response = await context.request.post(base + "/api/auth/session", {
      data: credentials(accountId),
    });
    check(response.status() === 200, "Login failed: " + accountId);
    return context;
  };
  const author = await make("demo-owner-susu");
  const recipient = await make("demo-owner-midis");
  const other = await make("demo-owner-csu");
  const coordinator = await make("demo-admin");
  const guest = await page.context().browser().newContext();
  try {
    check(
      (await guest.request.get(base + "/api/requests")).status() === 401,
      "Anonymous privacy"
    );
    const input = {
      operationId: await page.evaluate(() => crypto.randomUUID()),
      recipientUniversityId: "midis",
      subject: "МИДиС и ЮУрГУ: данные об образовательном проекте",
      question:
        "Уточните число участников совместного проекта МИДиС и ЮУрГУ за 2026 год и приложите официальный источник.",
      linkedCardId: null,
    };
    const created = await author.request.post(base + "/api/requests", {
      data: input,
    });
    check(
      created.status() === 201,
      "Create " + created.status() + " " + (await created.text())
    );
    const item = await created.json();
    const duplicate = await author.request.post(base + "/api/requests", {
      data: input,
    });
    check(
      (await duplicate.json()).id === item.id,
      "Creation replay idempotency"
    );
    check(
      (
        await author.request.post(base + "/api/requests", {
          data: {
            ...input,
            question: "Изменённый запрос с тем же идентификатором",
          },
        })
      ).status() === 409,
      "Changed replay blocked"
    );
    check(
      !(
        await (await other.request.get(base + "/api/requests")).json()
      ).items.some((row) => row.id === item.id),
      "Other university cannot read"
    );
    const answer = {
      action: "answer",
      operationId: await page.evaluate(() => crypto.randomUUID()),
      revision: 0,
      answer:
        "Официальное число участников пока уточняется. Предлагаем сверить сведения с ответственным за совместный проект.",
      evidenceUrl: "https://midis.ru/",
    };
    check(
      (
        await other.request.patch(base + "/api/requests/" + item.id, {
          data: answer,
        })
      ).status() === 404,
      "Other university cannot answer"
    );
    check(
      (
        await author.request.patch(base + "/api/requests/" + item.id, {
          data: answer,
        })
      ).status() === 403,
      "Author cannot impersonate recipient"
    );
    const inbox = await (
      await recipient.request.get(base + "/api/requests")
    ).json();
    check(
      inbox.items.some((row) => row.id === item.id),
      "Recipient inbox"
    );
    const answered = await recipient.request.patch(
      base + "/api/requests/" + item.id,
      { data: answer }
    );
    check(answered.status() === 200, "Recipient answer " + answered.status());
    check(
      (
        await (
          await recipient.request.patch(base + "/api/requests/" + item.id, {
            data: answer,
          })
        ).json()
      ).revision === 1,
      "Answer replay"
    );
    check(
      (
        await recipient.request.patch(base + "/api/requests/" + item.id, {
          data: {
            ...answer,
            operationId: await page.evaluate(() => crypto.randomUUID()),
          },
        })
      ).status() === 409,
      "Stale revision blocked"
    );
    const submission = {
      action: "submit",
      revision: 1,
      operationId: await page.evaluate(() => crypto.randomUUID()),
    };
    const submitted = await author.request.patch(
      base + "/api/requests/" + item.id,
      { data: submission }
    );
    check(submitted.status() === 200, "Submit review " + submitted.status());
    const final = await submitted.json();
    check(
      final.status === "submitted" && final.candidateCardId,
      "Pending card handoff"
    );
    check(
      (
        await (
          await author.request.patch(base + "/api/requests/" + item.id, {
            data: submission,
          })
        ).json()
      ).candidateCardId === final.candidateCardId,
      "Submission replay"
    );
    const publicCards = await (
      await guest.request.get(base + "/api/knowledge/cards")
    ).json();
    check(
      !publicCards.some((card) => card.id === final.candidateCardId),
      "Pending answer cannot become public fact"
    );
    check(
      (
        await author.request.post(base + "/api/requests", {
          headers: { origin: "null" },
          data: {
            ...input,
            operationId: await page.evaluate(() => crypto.randomUUID()),
          },
        })
      ).status() === 403,
      "CSRF origin rejected"
    );
    const candidate = (await (await coordinator.request.get(base + "/api/knowledge/cards")).json()).find(card => card.id === final.candidateCardId);
    check(candidate && candidate.readinessStage === "Не уточнено" && candidate.contour === "не уточнён", "An answer does not invent project stage or contour");
    const recipientSession = await recipient.request.get(base + "/api/auth/session");
    check(recipientSession.status() === 200, "Read the synthetic recipient session");
    const recipientId = (await recipientSession.json()).user?.id;
    check(recipientId && candidate.ownerIds?.length === 1 && candidate.ownerIds[0] === recipientId, "The candidate is assigned to the designated receiving owner");
    const prematureDecision = await coordinator.request.post(base + "/api/knowledge/cards/" + final.candidateCardId + "/moderation", { headers: { "If-Match": candidate.updatedAt }, data: { action: "approve" } });
    check(prematureDecision.status() === 409, "Unknown project metadata must be completed before approval");
    const completedResponse = await coordinator.request.put(base + "/api/knowledge/cards/" + final.candidateCardId, { headers: { "If-Match": candidate.updatedAt }, data: { ...candidate, readinessStage: "Идея", contour: "собственный проект вуза" } });
    check(completedResponse.status() === 200, "Complete synthetic project metadata");
    const completed = await completedResponse.json();
    const moderationPath = base + "/api/knowledge/cards/" + final.candidateCardId + "/moderation";
    check((await coordinator.request.post(moderationPath, { data: { action: "approve" } })).status() === 428, "Publication requires the current If-Match");
    check((await coordinator.request.post(moderationPath, { headers: { "If-Match": candidate.updatedAt }, data: { action: "approve" } })).status() === 409, "Publication refuses an older proposal version");
    const decision = await coordinator.request.post(base + "/api/knowledge/cards/" + final.candidateCardId + "/moderation", { headers: { "If-Match": completed.updatedAt }, data: { action: "approve" } });
    check(decision.status() === 200, "Coordinator approves candidate");
    const approved = (await (await author.request.get(base + "/api/requests")).json()).items.find(row => row.id === item.id);
    check(approved.status === "approved" && approved.candidateCardId === final.candidateCardId, "Request now reports approval and links the official card");
    const view = await recipient.newPage();
    await view.goto(base + "/requests");
    check(
      (await view
        .getByRole("heading", { name: "Входящие запросы", exact: true })
        .count()) === 1,
      "Requests page"
    );
    await view.setViewportSize({ width: 390, height: 844 });
    check(
      await view.evaluate(
        () => document.documentElement.scrollWidth === innerWidth
      ),
      "Mobile requests overflow"
    );
    return (
      JSON.stringify({
        passed: true,
        checks:
          "Unicode cross-university create, replay, recipient inbox, privacy, unauthorized reply, optimistic revision, pending-card transaction, public ACL, CSRF, mobile UI",
        requestId: item.id,
      })
    );
  } finally {
    await coordinator.close();
    await author.close();
    await recipient.close();
    await other.close();
    await guest.close();
  }
}
