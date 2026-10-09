/**
 * UI test helpers: render a plugin component with the mocked SDK UI hooks and a mocked API client.
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { BoardroomApiError, BoardroomApiProvider, type BoardroomApi } from "../../src/ui/api.js";
import { sdkUi } from "./sdk-ui-mock.js";

export { sdkUi };

export interface ApiCall {
  method: string;
  path: string;
  query: Record<string, string> | undefined;
  body: unknown;
}

type Responder = unknown | ((call: ApiCall) => unknown | Promise<unknown>);

export interface MockBoardroomApi extends BoardroomApi {
  /** Every call, oldest first. */
  calls: ApiCall[];
  /**
   * Answer `method path` with a value, or with a function of the call (throw to fail it). Calls to the
   * host's own board API (`getHost`) are keyed `GET host:<path>`, for example `GET host:/companies/c1/agents`.
   */
  on(method: string, path: string, responder: Responder): MockBoardroomApi;
  /** Whether `method path` already has an answer. */
  has(method: string, path: string): boolean;
}

/** An API client whose routes the test defines. Unmocked routes reject with a 404 `BoardroomApiError`. */
export function createMockApi(): MockBoardroomApi {
  const routes = new Map<string, Responder>();
  const calls: ApiCall[] = [];

  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const record: ApiCall = { method, path, query, body };
    calls.push(record);
    const key = `${method} ${path}`;
    if (!routes.has(key)) {
      throw new BoardroomApiError(404, { error: `Unmocked Boardroom API call: ${key}` });
    }
    const responder = routes.get(key);
    const value = typeof responder === "function" ? await (responder as (c: ApiCall) => unknown)(record) : responder;
    return structuredClone(value) as T;
  }

  const api: MockBoardroomApi = {
    calls,
    on(method, path, responder) {
      routes.set(`${method.toUpperCase()} ${path}`, responder);
      return api;
    },
    has: (method, path) => routes.has(`${method.toUpperCase()} ${path}`),
    get: (path, query) => call("GET", path, undefined, query),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    delete: (path, query) => call("DELETE", path, undefined, query),
    getHost: (path, query) => call("GET", `host:${path}`, undefined, query),
    postHost: (path, body) => call("POST", `host:${path}`, body),
  };
  return api;
}

export interface RenderOptions {
  api?: BoardroomApi;
  hostContext?: Partial<PluginHostContext>;
}

/**
 * Render `build(context)` inside the Boardroom API provider, with the host context applied to
 * the mocked SDK hooks. Returns the testing-library result plus the context and API used.
 */
export function renderWithBoardroom(
  build: (context: PluginHostContext) => ReactElement,
  options: RenderOptions = {},
): RenderResult & { context: PluginHostContext; api: BoardroomApi } {
  if (options.hostContext) sdkUi.setHostContext(options.hostContext);
  const context = sdkUi.state.hostContext;
  const api = options.api ?? createMockApi();
  const result = render(<BoardroomApiProvider api={api}>{build(context)}</BoardroomApiProvider>);
  return Object.assign(result, { context, api });
}
