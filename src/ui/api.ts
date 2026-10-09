import { createContext, createElement, useContext, type ReactNode } from "react";
import { BOARDROOM_PLUGIN_ID } from "../constants.js";

/**
 * Client for the plugin's scoped JSON routes (`/api/plugins/:pluginId/api/*`).
 *
 * Plugin UI runs same-origin inside the Paperclip app, so the board session cookie authenticates
 * the call. Errors are thrown as `BoardroomApiError` with the host's `{ error }` message, so the
 * UI can show them instead of failing silently.
 */
export interface BoardroomApi {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export class BoardroomApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Boardroom request failed with status ${status}`;
    super(message);
    this.name = "BoardroomApiError";
  }
}

export interface BoardroomApiOptions {
  /**
   * Path segment the host routes plugin API calls by. The host accepts the manifest id (plugin key)
   * as well as the database id, so the default needs no lookup (confirmed against the host router).
   */
  pluginId?: string;
  fetch?: typeof fetch;
}

export function createBoardroomApi(options: BoardroomApiOptions = {}): BoardroomApi {
  const base = `/api/plugins/${encodeURIComponent(options.pluginId ?? BOARDROOM_PLUGIN_ID)}/api`;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
    const hasBody = body !== undefined;
    const response = await doFetch(`${base}${path}${search}`, {
      method,
      credentials: "include",
      headers: hasBody ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const text = response.status === 204 ? "" : await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }
    if (!response.ok) throw new BoardroomApiError(response.status, parsed);
    return parsed as T;
  }

  return {
    get: (path, query) => call("GET", path, undefined, query),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    delete: (path) => call("DELETE", path),
  };
}

const BoardroomApiContext = createContext<BoardroomApi | null>(null);

export function BoardroomApiProvider({ api, children }: { api: BoardroomApi; children?: ReactNode }) {
  return createElement(BoardroomApiContext.Provider, { value: api }, children);
}

let defaultApi: BoardroomApi | null = null;

/** The API client for this subtree: the provided one (tests), or the real client. */
export function useBoardroomApi(): BoardroomApi {
  const provided = useContext(BoardroomApiContext);
  if (provided) return provided;
  defaultApi ??= createBoardroomApi();
  return defaultApi;
}
