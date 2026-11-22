import {
  getDemoError,
  readBrowserDemo,
  writeBrowserDemo,
  type BrowserDemoState,
} from "./browser-demo";

export type WorkspaceRequest = (
  url: string,
  init?: RequestInit
) => Promise<Response>;
export type DemoCall = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly state: BrowserDemoState;
  body(): unknown;
  save(state: BrowserDemoState): void;
};
export type DemoHandler = (
  call: DemoCall
) => Response | undefined | Promise<Response | undefined>;

type DemoSessionIdentity = Pick<BrowserDemoState, "profile" | "epoch">;

class DemoSessionChanged extends Error {
  readonly status = 409;

  constructor() {
    super(
      "Учебная роль или данные демо изменились. Повторите действие в открытой сессии."
    );
  }
}

const origin = "https://browser-demo.invalid";
type DemoStorage = Pick<Storage, "getItem" | "setItem">;
const pendingWrites = new WeakMap<DemoStorage, Promise<unknown>>();

export function queueDemoWrite<T>(
  storage: DemoStorage,
  write: () => T | Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const run = () => {
    signal?.throwIfAborted();
    return write();
  };
  if (typeof window !== "undefined" && window.navigator.locks) {
    return window.navigator.locks.request(
      "campus-browser-demo",
      { signal },
      run
    );
  }
  const before = pendingWrites.get(storage);
  const result = (before ?? Promise.resolve()).then(run, run);
  pendingWrites.set(storage, result);
  return result;
}

export function demoError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export function createBrowserDemoRequest(
  storage: DemoStorage,
  mounted: DemoSessionIdentity,
  handlers: readonly DemoHandler[] = [],
  onSave?: (state: BrowserDemoState) => void
): WorkspaceRequest {
  const { profile, epoch } = mounted;
  function assertCurrentSession(state: DemoSessionIdentity) {
    if (state.profile !== profile || state.epoch !== epoch) {
      throw new DemoSessionChanged();
    }
  }
  function readCurrentSession() {
    const state = readBrowserDemo(storage);
    assertCurrentSession(state);
    return state;
  }

  async function request(href: string, init: RequestInit) {
    init.signal?.throwIfAborted();
    if (!href.startsWith("/api/"))
      return demoError("Действие недоступно в демо.", 404);
    const url = new URL(href, origin);
    if (url.origin !== origin)
      return demoError("Действие недоступно в демо.", 404);
    try {
      readCurrentSession();
      const call: DemoCall = {
        url,
        method: (init.method ?? "GET").toUpperCase(),
        headers: new Headers(init.headers),
        get state() {
          return readCurrentSession();
        },
        body: () => {
          if (typeof init.body !== "string")
            throw new Error("Ожидается запрос в формате JSON.");
          return JSON.parse(init.body) as unknown;
        },
        save: (next) => {
          init.signal?.throwIfAborted();
          assertCurrentSession(next);
          readCurrentSession();
          writeBrowserDemo(storage, next);
          onSave?.(next);
        },
      };
      for (const handle of handlers) {
        const response = handle(call);
        if (response) {
          const result = await response;
          init.signal?.throwIfAborted();
          readCurrentSession();
          if (result) return result;
        }
      }
      return demoError("Действие недоступно в демо.", 404);
    } catch (error) {
      init.signal?.throwIfAborted();
      return demoError(
        getDemoError(error),
        error instanceof Error &&
          "status" in error &&
          typeof error.status === "number"
          ? error.status
          : 400
      );
    }
  }
  return (href, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    return ["POST", "PUT", "PATCH", "DELETE"].includes(method)
      ? queueDemoWrite(
          storage,
          () => request(href, init),
          init.signal ?? undefined
        )
      : request(href, init);
  };
}
