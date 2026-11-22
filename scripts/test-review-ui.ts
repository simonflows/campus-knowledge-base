import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  Children,
  createElement,
  isValidElement,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { toast } from "sonner";
import { KnowledgeCardAccessPanel } from "../components/knowledge/knowledge-card-access-panel";
import { KnowledgeCardForm } from "../components/knowledge/knowledge-card-form";
import { KnowledgeModerationPanel } from "../components/knowledge/knowledge-moderation-panel";
import { Button } from "../components/ui/button";
import { demoAccounts } from "../lib/auth";
import {
  folderIds,
  knowledgeSeedCards,
  type KnowledgeCard,
  type ProjectCard,
} from "../lib/knowledge";

type ViewProps = {
  children?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void | Promise<void>;
  onSubmit?: (event: { preventDefault(): void }) => Promise<void>;
  value?: string;
};

function findControl(
  tree: ReactNode,
  selector: (props: ViewProps, type: unknown) => boolean
): ViewProps | undefined {
  for (const node of Children.toArray(tree)) {
    if (!isValidElement<ViewProps>(node)) continue;
    if (selector(node.props, node.type)) return node.props;
    const nestedControl = findControl(node.props.children, selector);
    if (nestedControl) return nestedControl;
  }
}

test("форма сохраняет версию, с которой были заполнены поля", async (context) => {
  const original = {
    ...pending,
    folderId: folderIds.subfolder(pending.initiatorUniversityId, "products"),
  };
  const changed = {
    ...original,
    title: "Заголовок после обновления карточки",
    updatedAt: "2026-11-22T09:46:01.123Z",
  };
  let submit: ViewProps["onSubmit"];
  const fetchMock = context.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Карточка изменилась" }, { status: 409 })
  );
  function Capture() {
    const [updated, setUpdated] = useState(false);
    const view = KnowledgeCardForm({
      cards: [changed],
      customTypes: [],
      currentUser: coordinator,
      dbAvailable: true,
      initialCard: updated ? changed : original,
      onCreated() {},
      onCancel() {},
    });
    if (!updated) setUpdated(true);
    submit = findControl(view, (_, type) => type === "form")?.onSubmit;
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  assert.ok(submit);
  await submit({ preventDefault() {} });
  assert.equal(fetchMock.mock.callCount(), 1);
  const mockCall = fetchMock.mock.calls[0] as {
    arguments: Parameters<typeof fetch>;
  };
  const [, init] = mockCall.arguments;
  assert.equal(JSON.parse(String(init?.body)).title, original.title);
  assert.equal(new Headers(init?.headers).get("If-Match"), original.updatedAt);
});

function findAction(tree: ReactNode, label: string): ViewProps["onClick"] {
  const button = findControl(
    tree,
    ({ children }, type) =>
      type === Button && Children.toArray(children).includes(label)
  );
  if (button)
    assert.equal(Boolean(button.disabled), false, `Кнопка «${label}» доступна`);
  return button?.onClick;
}

const coordinator = demoAccounts.find((account) => account.role === "admin")!;
const participant = demoAccounts.find(
  (account) => account.role === "university_owner" && account.universityId
)!;
const seed = knowledgeSeedCards.find(
  (card): card is ProjectCard => card.type === "project"
)!;
const pending: ProjectCard = {
  ...seed,
  status: "pending",
  isJoint: false,
  participantUniversityIds: [],
  updatedAt: "2026-11-22T09:45:01.123Z",
};
const joint: ProjectCard = {
  ...pending,
  isJoint: true,
  participantUniversityIds: [
    participant.universityId!,
    participant.universityId === "susu" ? "midis" : "susu",
  ],
  participantApprovals: [],
};

for (const scenario of [
  { surface: "list", label: "Одобрить", action: "approve" },
  { surface: "list", label: "Отклонить", action: "reject" },
  { surface: "detail", label: "Одобрить", action: "approve" },
  { surface: "detail", label: "Отклонить", action: "reject" },
  {
    surface: "detail",
    label: "Подтвердить участие вуза",
    action: "confirm-participation",
  },
]) {
  test(`${scenario.surface}: ${scenario.action} передаёт версию показанной карточки`, async (context) => {
    const isParticipation = scenario.action === "confirm-participation";
    const card = isParticipation ? joint : pending;
    const updates: KnowledgeCard[] = [];
    const onCardUpdated = (next: KnowledgeCard) => updates.push(next);
    const response = { ...card, updatedAt: "2026-11-22T09:46:01.123Z" };
    const fetchMock = context.mock.method(globalThis, "fetch", async () =>
      Response.json(response)
    );
    let click: ViewProps["onClick"];
    function Capture() {
      const view =
        scenario.surface === "list"
          ? KnowledgeModerationPanel({
              cards: [card],
              onCardUpdated,
              onOpenCard() {},
            })
          : KnowledgeCardAccessPanel({
              card,
              currentUser: isParticipation ? participant : coordinator,
              dbAvailable: true,
              onCardUpdated,
              onEdit() {},
            });
      click = findAction(view, scenario.label);
      return null;
    }
    renderToStaticMarkup(
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams() },
        createElement(Capture)
      )
    );
    assert.ok(click, `Не найдена кнопка «${scenario.label}»`);
    await click();
    assert.equal(fetchMock.mock.callCount(), 1);
    const mockCall = fetchMock.mock.calls[0] as {
      arguments: Parameters<typeof fetch>;
    };
    const [url, init] = mockCall.arguments;
    assert.equal(url, `/api/knowledge/cards/${card.id}/moderation`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("If-Match"), card.updatedAt);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      action: scenario.action,
    });
    assert.deepEqual(updates, [response]);
  });
}

async function loadView<T>(load: () => Promise<T>): Promise<T> {
  // The event handlers do not need the production CSS loader.
  const styleLoader = registerHooks({
    load(url, options, next) {
      if (url.endsWith(".css"))
        return {
          format: "commonjs",
          source: "module.exports = {}",
          shortCircuit: true,
        };
      return next(url, options);
    },
  });
  return load().finally(() => styleLoader.deregister());
}

test("аналитика игнорирует ответ для запроса, который уже изменился", async (context) => {
  const { AnalyticsWorkspace } = await loadView(
    () => import("../components/analytics/analytics-workspace")
  );
  const requestedQuery = "Покажи лаборатории ЮУрГУ";
  const response = Promise.withResolvers<Response>();
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    () => response.promise
  );
  const success = context.mock.method(toast, "success", () => "test-toast");
  let submit: ViewProps["onClick"];
  let changeQuery: ViewProps["onChange"];
  function Capture() {
    const view = AnalyticsWorkspace({ cardsCount: 1, dbAvailable: true });
    const field = findControl(view, ({ id }) => id === "analytics-query");
    assert.ok(field?.onChange);
    if (!field.value) field.onChange({ target: { value: requestedQuery } });
    changeQuery = field.onChange;
    submit = findAction(view, "Собрать аналитику");
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  assert.ok(submit && changeQuery);
  const pendingRequest = submit();
  const mockCall = fetchMock.mock.calls[0] as {
    arguments: Parameters<typeof fetch>;
  };
  assert.deepEqual(JSON.parse(String(mockCall.arguments[1]?.body)), {
    query: requestedQuery,
  });
  changeQuery({ target: { value: "Покажи проекты МИДиС" } });
  response.resolve(Response.json({ cards: [{}], summary: { total: 1 } }));
  await pendingRequest;
  assert.equal(
    success.mock.callCount(),
    0,
    "Не показано подтверждение устаревшего отчёта"
  );
});

const requestSubject = "Сведения о лаборатории";
const requestQuestion = "Какие лаборатории работают в вузе?";
const createRequestProps = {
  initialItems: [],
  user: coordinator,
  available: true,
  initialQuestion: requestQuestion,
  initialCardId: null,
};

function fillRequest(view: ReactNode) {
  const recipient = findControl(view, ({ id }) => id === "request-recipient");
  const subject = findControl(view, ({ id }) => id === "request-subject");
  const question = findControl(view, ({ id }) => id === "request-question");
  assert.ok(recipient?.onChange && subject?.onChange && question);
  if (!recipient.value || !subject.value) {
    recipient.onChange({ target: { value: "midis" } });
    subject.onChange({ target: { value: requestSubject } });
    return;
  }
  return { recipient, subject, question };
}

const requestTestRouter: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

function renderRequestView(Capture: () => null) {
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: requestTestRouter },
      createElement(Capture)
    )
  );
}

test("отправка запроса отменяет уже запрошенное обновление списка", async (context) => {
  const { RequestsWorkspace } = await loadView(
    () => import("../components/requests/requests-workspace")
  );
  const listResponse = Promise.withResolvers<Response>();
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    async (_url: Parameters<typeof fetch>[0], request?: RequestInit) =>
      request?.method === "POST"
        ? Response.json({ id: "saved-request" })
        : listResponse.promise
  );
  let refresh: ViewProps["onClick"];
  let send: ViewProps["onSubmit"];
  function Capture() {
    const view = RequestsWorkspace(createRequestProps);
    if (fillRequest(view)) {
      refresh = findControl(
        view,
        (props) => props["aria-label"] === "Обновить"
      )?.onClick;
      send = findControl(view, (_, type) => type === "form")?.onSubmit;
    }
    return null;
  }
  renderRequestView(Capture);
  assert.ok(refresh && send);
  void refresh();
  await send({ preventDefault() {} });
  const readOldList = context.mock.fn(async () => ({ items: [] }));
  listResponse.resolve({ ok: true, json: readOldList } as unknown as Response);
  await setImmediate();
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(readOldList.mock.callCount(), 0, "Устаревший ответ пропущен");
});

test("поля нового запроса заблокированы, пока сервер сохраняет отправленный текст", async (context) => {
  const { RequestsWorkspace } = await loadView(
    () => import("../components/requests/requests-workspace")
  );
  const response = Promise.withResolvers<Response>();
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    () => response.promise
  );
  let sending: Promise<void> | undefined;
  let fields: ReturnType<typeof fillRequest>;
  function Capture() {
    const started = useRef(false);
    const view = RequestsWorkspace(createRequestProps);
    fields = fillRequest(view);
    if (fields && !started.current) {
      const send = findControl(view, (_, type) => type === "form")?.onSubmit;
      assert.ok(send);
      started.current = true;
      sending = send({ preventDefault() {} });
    }
    return null;
  }
  renderRequestView(Capture);
  assert.ok(fields && sending);
  assert.equal(fetchMock.mock.callCount(), 1);
  response.resolve(Response.json({ id: "saved-request" }));
  await sending;
  assert.equal(fields.recipient.disabled, true);
  assert.equal(fields.subject.disabled, true);
  assert.equal(fields.question.disabled, true);
});
