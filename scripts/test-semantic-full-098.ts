import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeAiFactReview, reviewFactsWithAi } from "../lib/canon-ai";
import { checkFactText, factCheckClaimSpans } from "../lib/fact-check";
import type { FactCheckProgress } from "../lib/fact-check-progress";
import { knowledgeSeedCards } from "../lib/knowledge";

type InputRow = { id: number; text: string; contextBefore?: string };
const articles = Array.from({ length: 96 }, (_, i) =>
  "В записи " + (i + 1) + " обсуждают отзыв участников, его обстоятельства и интерпретации автора."
);
const long = articles.join(" ");
const request = new Request("https://canon.invalid");
const row = ({ id, text }: InputRow) => ({
  id,
  quote: text,
  verdict: "outside",
  explanation: "Редакционная связка",
  correction: "",
  evidence: [],
});

test("every span of a long article is received and reviewed in bounded batches", async () => {
  const submitted = new Map<number, InputRow>();
  const context: string[] = [];
  let active = 0;
  let peak = 0;
  let total = 0;
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text: long, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, payload, maxTokens) => {
      active++;
      total++;
      peak = Math.max(peak, active);
      const { claims } = JSON.parse(payload) as { claims: InputRow[] };
      assert.ok(claims.length <= 24);
      assert.ok(claims.reduce((sum, claim) => sum + claim.text.length, 0) <= 3000);
      assert.ok((maxTokens ?? 0) <= 3000);
      for (const claim of claims) {
        assert.equal(submitted.has(claim.id), false);
        submitted.set(claim.id, claim);
        if (claim.contextBefore) context.push(claim.contextBefore);
      }
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { status: "ready", output: { outside: claims.map(claim => claim.id), opinions: [], claims: [] } };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.ok(total > 1);
  assert.ok(peak > 0 && peak <= 2);
  assert.equal(submitted.size, factCheckClaimSpans(long).length);
  assert.equal(review.mode, "semantic");
  assert.equal(review.reviewedSpans, articles.length);
  assert.equal(review.totalSpans, articles.length);
  assert.equal(review.claims.at(-1)?.quote, articles.at(-1));
  assert.ok(context.some(value => value.includes("интерпретации автора")));
  assert.ok(review.claims.every(claim => long.slice(claim.start, claim.end) === claim.quote));
});

test("a missing batch and inaccurate quote leave explicit partial coverage and preserve the tail", async () => {
  let calls = 0;
  let failed = 0;
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text: long, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, payload) => {
      const index = ++calls;
      const { claims } = JSON.parse(payload) as { claims: InputRow[] };
      if (index === 2) {
        failed = claims.length;
        return { status: "failed" };
      }
      return {
        status: "ready",
        output: { claims: claims.map((claim, position) =>
          index === 1 && position === 0 ? { ...row(claim), quote: "Такого фрагмента нет в статье" } : row(claim)
        ) },
      };
    },
  });
  assert.ok(calls >= 4);
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "mixed");
  assert.equal(review.rejectedClaims, 1);
  assert.equal(review.totalSpans, articles.length);
  assert.equal(review.reviewedSpans, articles.length - failed - 1);
  assert.ok(review.claims.every(claim => long.slice(claim.start, claim.end) === claim.quote));
  assert.equal(review.claims.at(-1)?.quote, articles.at(-1));
});

test("streaming recovers only omitted or conflicting extraction IDs using their exact text", async () => {
  const requested: number[][] = [];
  const progress: FactCheckProgress[] = [];
  const recoveredIds = [2, 4, 7];
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text: long, cards: knowledgeSeedCards,
    streaming: true, onProgress: value => progress.push(value),
    ask: async (_request, _account, _instruction, payload) => {
      const { claims, stage } = JSON.parse(payload) as { claims: InputRow[]; stage: string };
      assert.equal(stage, "extract");
      const ids = claims.map(claim => claim.id);
      const isInitial = ids.length > 4 && ids.includes(1);
      requested.push(ids);
      if (!isInitial) return { status: "ready", output: { outside: ids } };
      return { status: "ready", output: {
        outside: ids.filter(id => id !== 2 && id !== 7),
        claims: [
          { id: 3, verdict: "outside", quote: "Повторная неточная подпись" },
          { id: 4, verdict: "opinion", quote: "Неточная цитата с другой категорией" },
        ],
      } };
    },
  });
  assert.deepEqual(requested.at(-1), recoveredIds);
  const originalGroups = requested.length - 1;
  assert.ok(originalGroups > 1);
  assert.ok(requested.length <= 32);
  assert.deepEqual(progress.slice(-2), [
    { stage: "extract", completed: originalGroups, total: originalGroups + 1 },
    { stage: "extract", completed: originalGroups + 1, total: originalGroups + 1 },
  ]);
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "semantic");
  assert.equal(review.batches?.attempted, requested.length);
  assert.equal(review.ignoredAnnotations, 1);
  assert.equal(review.rejectedClaims, 0);
  assert.equal(review.reviewedSpans, articles.length);
  assert.deepEqual(review.claims.map(claim => claim.quote), articles);
});

test("stream recovery leaves failed transport groups untouched and attempts an omitted ID only once", async () => {
  const sent: number[][] = [];
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text: long, cards: knowledgeSeedCards, streaming: true,
    ask: async (_request, _account, _instruction, input) => {
      const { claims } = JSON.parse(input) as { claims: InputRow[] };
      const ids = claims.map(claim => claim.id);
      sent.push(ids);
      if (ids.includes(25)) return { status: "failed" };
      return { status: "ready", output: { outside: ids.filter(id => id !== 2) } };
    },
  });
  assert.equal(sent.filter(ids => ids.includes(25)).length, 1);
  assert.equal(sent.filter(ids => ids.includes(2)).length, 2);
  assert.deepEqual(sent.at(-1), [2]);
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "mixed");
  assert.equal(review.reviewedSpans, articles.length - 25);
  assert.equal(mergeAiFactReview(checkFactText(long, knowledgeSeedCards), review).canPublish, false);
});

test("an inconclusive recovery cannot remove an exact fact found in the first pass", async () => {
  const fact = "МИДиС подписал соглашение с KUKA";
  const tail = fact + ", согласно редакционной справке.";
  const text = long + " " + tail;
  const verified: string[] = [];
  let tailRequests = 0;
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards, streaming: true,
    ask: async (_request, _account, _instruction, input) => {
      const { claims, stage } = JSON.parse(input) as { claims: InputRow[]; stage: string };
      if (stage === "verify") {
        verified.push(...claims.map(claim => claim.text));
        return { status: "ready", output: { claims: claims.map(({ id }) => ({ id, verdict: "unknown" })) } };
      }
      const candidate = claims.find(claim => claim.text === tail);
      if (candidate && ++tailRequests > 1) return { status: "ready", output: { outside: [candidate.id] } };
      return { status: "ready", output: {
        outside: claims.filter(claim => claim !== candidate).map(claim => claim.id),
        ...(candidate && { claims: [{ id: candidate.id, quote: fact, verdict: "claim" }] }),
      } };
    },
  });
  assert.equal(tailRequests, 2);
  assert.deepEqual(verified, [fact]);
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "mixed");
  assert.equal(review.reviewedSpans, articles.length);
  assert.ok(review.claims.some(claim => claim.quote === fact && claim.verdict === "unknown"));
  const merged = mergeAiFactReview(checkFactText(text, knowledgeSeedCards), review);
  assert.equal(merged.canPublish, false);
  assert.ok(merged.summary.yellow > 0);
});

test("a single long sentence is fully traversed, with each returned quote unchanged", async () => {
  const text = "Подробное редакционное введение ".repeat(350).trim() + ".";
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, payload) => {
      const { claims } = JSON.parse(payload) as { claims: InputRow[] };
      return { status: "ready", output: { claims: claims.map(row) } };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "semantic");
  assert.ok(review.claims.length > 1);
  assert.ok(review.claims.every(claim => text.slice(claim.start, claim.end) === claim.quote));
  assert.equal(review.claims.map(claim => claim.quote).join(" ").replace(/\s+/gu, ""), text.replace(/\s+/gu, ""));
});

test("an aborted article review does not queue every batch or return early accepted findings", async () => {
  const controller = new AbortController();
  let entered = 0;
  const review = await reviewFactsWithAi({
    request: new Request(request.url, { signal: controller.signal }), accountId: "fixture", text: long, cards: knowledgeSeedCards,
    ask: async () => {
      entered++;
      controller.abort();
      return { status: "ready", output: { claims: [] } };
    },
  });
  assert.equal(review.status, "failed");
  assert.ok(entered > 0 && entered <= 2);
});

test("an input that cannot fit the full call budget makes no sampled provider request", async () => {
  let entered = 0;
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text: "Тезис редакции. ".repeat(1200), cards: [],
    ask: async () => {
      entered++;
      return { status: "failed" };
    },
  });
  assert.equal(review.status, "too-long");
  assert.equal(entered, 0);
});

test("an atom with an inferred subject preserves literal predicates and leaves unverifiable claims unknown", async () => {
  const text = "Робот KUKA упомянут в интервью. Он обрабатывает титан.";
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async () => ({
      status: "ready",
      output: { claims: [
        { id: 1, verdict: "outside" },
        { id: 2, quote: "неизвестное действие", verdict: "unknown", atom: { kind: "metric", subject: "Робот KUKA", predicate: "неизвестное действие" } },
        { id: 2, verdict: "unknown", atom: { kind: "relationship", subject: "Робот KUKA", predicate: "обрабатывает титан" } },
      ] },
    }),
  });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status !== "ready") return;
  assert.equal(reviewed.rejectedClaims, 1);
  assert.equal(reviewed.mode, "mixed");
  assert.equal(reviewed.claims[1].atom?.subject, "Робот KUKA");
  assert.equal(text.slice(reviewed.claims[1].start, reviewed.claims[1].end), "Он обрабатывает титан.");
  const merged = mergeAiFactReview(checkFactText(text, knowledgeSeedCards), reviewed);
  assert.equal(merged.findings.find(finding => finding.quote === "Он обрабатывает титан.")?.level, "yellow");
});

test("a repeated fragment requires valid relative offsets and cannot use context as a citation span", async () => {
  const text = "Заголовок. Спасибо, спасибо, спасибо.";
  const quote = "спасибо";
  const start = "Спасибо, ".length;
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: [],
    ask: async () => ({
      status: "ready",
      output: { claims: [
        { id: 1, verdict: "outside" },
        { id: 2, quote, verdict: "outside" },
        { id: 2, quote, start, end: start + quote.length, verdict: "outside" },
        { id: 2, quote: "Заголовок", start: 0, end: "Заголовок".length, verdict: "outside" },
      ] },
    }),
  });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status !== "ready") return;
  assert.equal(reviewed.rejectedClaims, 2);
  assert.equal(reviewed.mode, "mixed");
  assert.equal(reviewed.claims[1].start, text.indexOf(quote));
  assert.equal(text.slice(reviewed.claims[1].start, reviewed.claims[1].end), quote);
});

test("evidence in the middle and tail keeps the exact text and approved version", async () => {
  const middle = "Общая площадь кампуса составляет 114 тыс. кв. метров.";
  const tail = "Общая площадь кампуса составляет 123 тыс. кв. метров.";
  const text = [articles.slice(0, 42).join(" "), middle, articles.slice(42).join(" "), tail].join(" ");
  const checkedAtVerification: string[] = [];
  const progress: FactCheckProgress[] = [];
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    streaming: true, onProgress: value => progress.push(value),
    ask: async (_request, _account, _instruction, input) => {
      const { claims, sources, stage } = JSON.parse(input);
      const campus = sources.find((source: { cardId: string }) => source.cardId === "campus-passport");
      assert.ok(campus);
      if (stage === "extract") assert.equal(campus.facts, undefined);
      if (stage === "verify") checkedAtVerification.push(...claims.map((claim: InputRow) => claim.text));
      const sourceFact = campus.facts?.find((fact: { field: string; label: string }) => fact.field.startsWith("campusMetrics.") && fact.label === "Общая площадь объектов");
      return {
        status: "ready",
        output: stage === "extract" ? {
          outside: claims.filter((claim: InputRow) => claim.text !== middle && claim.text !== tail).map((claim: InputRow) => claim.id),
          facts: claims.filter((claim: InputRow) => claim.text === middle || claim.text === tail).map((claim: InputRow) => claim.id),
          opinions: [],
        } : { claims: claims.map((claim: InputRow) => {
          if (claim.text !== middle && claim.text !== tail) return row(claim);
          const atom = { kind: "metric", subject: "Общая площадь кампуса", predicate: "составляет", unit: "кв. метров" };
          return {
            id: claim.id, verdict: claim.text === middle ? "contradicted" : "supported",
            atom,
            evidence: [{ sourceId: campus.id, factId: sourceFact.id }],
          };
        }) },
      };
    },
  });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status !== "ready") return;
  assert.equal(reviewed.mode, "semantic");
  assert.deepEqual(checkedAtVerification, [middle, tail]);
  assert.deepEqual(reviewed.verification, { total: 2, completed: 2 });
  const extractionProgress = progress.filter(value => value.stage === "extract");
  const extractionTotal = extractionProgress[0].total;
  assert.ok(extractionTotal > 1);
  assert.deepEqual(progress, [
    ...Array.from({ length: extractionTotal + 1 }, (_, completed) => ({
      stage: "extract", completed, total: extractionTotal,
    })),
    { stage: "verify", completed: 0, total: 1 },
    { stage: "verify", completed: 1, total: 1 },
  ]);
  assert.deepEqual(reviewed.claims.filter(claim => claim.evidence.length).map(claim => [
    claim.quote, claim.start, claim.verdict, claim.evidence[0].cardId, claim.evidence[0].href.includes("version=cv-"),
  ]), [
    [middle, text.indexOf(middle), "contradicted", "campus-passport", true],
    [tail, text.indexOf(tail), "supported", "campus-passport", true],
  ]);
});

test("a paraphrased or malformed atom cannot discard a separately verified literal claim", async () => {
  const text = "Мне нравится город. Общая площадь кампуса составляет 123 тыс. кв. метров.";
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { sources } = JSON.parse(input);
      const campus = sources.find((source: { cardId: string }) => source.cardId === "campus-passport");
      const sourceFact = campus.facts.find((fact: { field: string; label: string }) => fact.field.startsWith("campusMetrics.") && fact.label === "Общая площадь объектов");
      return {
        status: "ready",
        output: { claims: [
          { id: 1, verdict: "opinion", atom: { kind: "opinion", subject: "город", predicate: "мне нравится" } },
          { id: 2, verdict: "supported", atom: { kind: "metric", subject: "Кампус", predicate: "имеет площадь" }, evidence: [{ sourceId: campus.id, factId: sourceFact.id }] },
        ] },
      };
    },
  });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status !== "ready") return;
  assert.equal(reviewed.mode, "semantic");
  assert.deepEqual(reviewed.claims.map(claim => [claim.verdict, claim.atom]), [["opinion", undefined], ["supported", undefined]]);
});

test("nested evidence is validated exactly and a missing reference remains unknown", async () => {
  const text = "Общая площадь кампуса составляет 123 тыс. кв. метров. Робот KUKA лечит пациентов на Луне.";
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { sources } = JSON.parse(input);
      const campus = sources.find((source: { cardId: string }) => source.cardId === "campus-passport");
      const metric = campus.facts.find((fact: { label: string }) => fact.label === "Общая площадь объектов");
      return {
        status: "ready",
        output: { claims: [
          { id: 1, verdict: "supported", atom: { kind: "metric", subject: "Общая площадь кампуса", predicate: "составляет", period: null, unit: null, evidence: [{ sourceId: campus.id, factId: metric.id }] } },
          { id: 2, verdict: "supported", atom: { kind: "other", subject: "Робот KUKA", predicate: "лечит" } },
        ] },
      };
    },
  });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status !== "ready") return;
  assert.deepEqual(reviewed.claims.map(claim => [claim.verdict, claim.evidence.length]), [["supported", 1], ["unknown", 0]]);
  assert.equal(reviewed.mode, "mixed");
  assert.equal(reviewed.rejectedClaims, 1);
  assert.equal(reviewed.reviewedSpans, 1);
});

test("extraction cannot confirm a claim or report full coverage if verification fails", async () => {
  const unverified = "Робот KUKA лечит пациентов на Луне.";
  const text = long + " " + unverified;
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { claims, sources, stage } = JSON.parse(input);
      if (stage === "verify") {
        assert.ok(claims.some((claim: InputRow) => claim.text === unverified));
        return { status: "failed" };
      }
      const lab = sources.find((source: { cardId: string }) => source.cardId === "lab-midis-kuka");
      return {
        status: "ready",
        output: { claims: claims.map((claim: InputRow) => claim.text === unverified
          ? { id: claim.id, verdict: "supported", evidence: [{ sourceId: lab.id, factId: "f2" }], candidates: [lab.id] }
          : row(claim)) },
      };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "mixed");
  assert.equal(review.classifiedSpans, review.totalSpans);
  assert.equal(review.reviewedSpans, (review.totalSpans ?? 0) - 1);
  assert.deepEqual(review.verification, { total: 1, completed: 0 });
  assert.ok(review.claims.every(claim => claim.verdict !== "supported"));
  const merged = mergeAiFactReview(checkFactText(text, knowledgeSeedCards), review);
  assert.equal(merged.findings.find(finding => finding.quote === unverified)?.level, "yellow");
});

test("a dense 60,000-character article can fit the full examination budget", async () => {
  const phrase = "Редакционное вступление объясняет происхождение одного из вопросов в интервью, ход разговора, "
    + "предыдущие реплики собеседников и то, каким образом их высказывания были включены в этот материал.";
  const text = (phrase + " ").repeat(Math.ceil(60_000 / (phrase.length + 1))).slice(0, 60_000);
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { claims, stage } = JSON.parse(input) as { claims: InputRow[]; stage?: string };
      assert.equal(stage, "extract");
      return { status: "ready", output: { outside: claims.map(claim => claim.id) } };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "semantic");
  assert.equal(review.reviewedSpans, review.totalSpans);
  assert.ok(review.batches && review.batches.attempted <= 32);
  const last = review.claims.at(-1);
  assert.ok(last && last.end >= text.trimEnd().length);
});

test("overlapping compact labels and duplicate descriptions preserve precise atomic coverage", async () => {
  const role = "Ректор МИДИС Максим Усынин";
  const tail = role + ", по моему мнению, убедителен.";
  const text = long + " " + tail;
  const seen: string[] = [];
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { claims, stage } = JSON.parse(input) as { claims: InputRow[]; stage?: string };
      if (stage === "verify") {
        seen.push(...claims.map(claim => claim.text));
        return { status: "ready", output: { claims: claims.map(claim => ({ id: claim.id, verdict: "unknown" })) } };
      }
      const exact = claims.find(claim => claim.text === tail);
      if (!exact) return { status: "ready", output: { outside: claims.map(claim => claim.id) } };
      const fact = { id: exact.id, quote: role, verdict: "facts" };
      return {
        status: "ready",
        output: {
          outside: claims.map(claim => claim.id),
          facts: Array.from({ length: 25 }, (_, index) => 10_000 + index),
          claims: [fact, fact],
        },
      };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.mode, "semantic");
  assert.equal(review.rejectedClaims, 0);
  assert.equal(review.ignoredAnnotations, 25);
  assert.deepEqual(seen, [role]);
  assert.deepEqual(review.claims.slice(-2).map(claim => [claim.quote, claim.verdict]), [
    [role, "unknown"],
    [", по моему мнению, убедителен.", "outside"],
  ]);
});

test("dense factual material receives verification instead of losing the entire second phase to the call cap", async () => {
  const area = "Общая площадь кампуса составляет 123 тыс. кв. метров.";
  const second = "Сводка по кампусу перечисляет обстоятельства подготовки рабочего календаря для команд "
    + "резидентов и поясняет, что участники обсуждали возможность опубликовать справочник после текущего набора заявок.";
  const text = (area + " " + second + " ").repeat(210).trim();
  assert.ok(text.length > 50_000 && text.length <= 60_000);
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { stage, claims } = JSON.parse(input) as { claims: InputRow[]; stage?: string };
      return stage === "verify"
        ? { status: "ready", output: { claims: claims.map(claim => ({ id: claim.id, verdict: "unknown" })) } }
        : { status: "ready", output: { facts: claims.map(claim => claim.id) } };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.equal(review.verification?.total, 420);
  assert.ok(review.verification && review.verification.completed > 0);
  assert.ok(review.batches && review.batches.attempted <= 32);
});

test("a model cannot certify a literal fragment by removing its factual qualification", async () => {
  const quote = "Робот KUKA работает на площадке МИДиС";
  for (const text of [
    "Если " + quote + ", ситуация изменится.",
    "В публикации приведено ошибочное утверждение: «" + quote + "».",
    "«" + quote + "», — неверно сказал участник.",
    quote + ", но это гипотеза.",
  ]) {
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: knowledgeSeedCards,
      ask: async (_request, _account, _instruction, input) => {
        const { claims, sources } = JSON.parse(input) as { claims: InputRow[]; sources: Array<{ id: string; cardId: string; facts: Array<{ id: string; field: string }> }> };
        const lab = sources.find(source => source.cardId === "lab-midis-kuka")!;
        const reference = lab.facts.find(fact => fact.field === "referenceDescription")!;
        return {
          status: "ready",
          output: { claims: claims.flatMap(claim => {
            const start = claim.text.indexOf(quote);
            if (start < 0) return [row(claim)];
            const before = claim.text.slice(0, start).trim();
            const after = claim.text.slice(start + quote.length).trim();
            return [
              ...(before ? [{ id: claim.id, quote: before, verdict: "outside" }] : []),
              { id: claim.id, quote, verdict: "supported", evidence: [{ sourceId: lab.id, factId: reference.id }] },
              ...(after ? [{ id: claim.id, quote: after, verdict: "outside" }] : []),
            ];
          }) },
        };
      },
    });
    assert.equal(review.status, "ready");
    if (review.status !== "ready") continue;
    assert.equal(review.claims.find(claim => claim.quote === quote)?.verdict, "unknown", text);
    const result = mergeAiFactReview(checkFactText(text, knowledgeSeedCards), review);
    assert.equal(result.canPublish, false, text);
    assert.ok(result.findings.every(finding => finding.level !== "green" || finding.quote !== quote), text);
  }
});

test("a dated restatement cannot inherit the current metric, while an independent later fact leaves it intact", async () => {
  const quote = "Общая площадь кампуса составляет 123 тыс. кв. метров";
  const text = quote + ", но это расчёт на 2040 год.";
  const ai = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input) => {
      const { claims, sources } = JSON.parse(input);
      const campus = sources.find((source: { cardId: string }) => source.cardId === "campus-passport");
      const fact = campus.facts.find((source: { label: string }) => source.label === "Общая площадь объектов");
      return {
        status: "ready",
        output: { claims: claims.map((claim: InputRow) => claim.text === quote
          ? { id: claim.id, verdict: "supported", evidence: [{ sourceId: campus.id, factId: fact.id }] }
          : { id: claim.id, verdict: "unknown" }) },
      };
    },
  });
  assert.equal(ai.status, "ready");
  if (ai.status !== "ready") return;
  assert.equal(ai.claims.find(claim => claim.quote === quote)?.verdict, "unknown");
  assert.equal(checkFactText(text, knowledgeSeedCards).summary.green, 0);
  const independent = quote + ", а в 2040 году автор планирует напечатать новую книгу.";
  assert.ok(checkFactText(independent, knowledgeSeedCards).findings.some(finding => finding.level === "green" && finding.quote === quote));
});

test("an editorial hedge does not veto a model-recognized statement about an approved subject", async () => {
  for (const text of [
    "Мне кажется, МИДиС купил робота KUKA.",
    "По моему мнению, МИДиС подписал соглашение с KUKA.",
  ]) {
    const ai = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: knowledgeSeedCards,
      ask: async () => ({ status: "ready", output: { claims: [{ id: 1, verdict: "unknown" }] } }),
    });
    assert.equal(ai.status, "ready");
    if (ai.status !== "ready") continue;
    assert.equal(ai.claims[0].verdict, "unknown", text);
    assert.ok(mergeAiFactReview(checkFactText(text, knowledgeSeedCards), ai).summary.yellow > 0);
  }
});
