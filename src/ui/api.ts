import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { BOARDROOM_PLUGIN_ID } from "../constants.js";
import type {
  CreateRoomRequest,
  CreateWorkRequest,
  CreateWorkResponse,
  MessageListResponse,
  RemoveWorkLinkResponse,
  RoomDetail,
  RoomListResponse,
  RoundListResponse,
  SendMessageRequest,
  SendMessageResponse,
  UpdateDecisionRequest,
  WorkLinkView,
} from "../api/types.js";

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
  delete<T>(path: string, query?: Record<string, string>): Promise<T>;
  /** GET on the host's own board API (`/api/...`), for company data the plugin routes do not own (agents, projects, issues). */
  getHost<T>(path: string, query?: Record<string, string>): Promise<T>;
}

/**
 * A non-2xx answer. The plugin's routes reply `{ error: <code>, message, details? }`; the host's own
 * replies (auth, validation) are `{ error: <text> }`. `message` is the text to show, `code` the stable
 * machine code (the host's text for a host reply).
 */
export class BoardroomApiError extends Error {
  readonly code: string | null;
  readonly details: unknown;

  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const record = body && typeof body === "object" ? (body as { error?: unknown; message?: unknown; details?: unknown }) : {};
    const code = typeof record.error === "string" ? record.error : null;
    const message =
      typeof record.message === "string" && record.message
        ? record.message
        : (code ?? `Boardroom request failed with status ${status}`);
    super(message);
    this.name = "BoardroomApiError";
    this.code = code;
    this.details = record.details;
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
  const pluginBase = `/api/plugins/${encodeURIComponent(options.pluginId ?? BOARDROOM_PLUGIN_ID)}/api`;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    base = pluginBase,
  ): Promise<T> {
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
    delete: (path, query) => call("DELETE", path, undefined, query),
    getHost: (path, query) => call("GET", path, undefined, query, "/api"),
  };
}

type JsonObject = Record<string, unknown>;

/**
 * One typed function per route of the plugin API, with the company id added the way each route
 * expects it (query for GET and DELETE, body for POST and PATCH; the issue lookup resolves the
 * company from the issue). Routes that later tickets implement are typed loosely here; the ticket
 * that builds a route tightens its types.
 */
export interface BoardroomClient {
  listRooms(): Promise<RoomListResponse>;
  createRoom(input: Omit<CreateRoomRequest, "companyId">): Promise<RoomDetail>;
  getRoom(roomId: string): Promise<RoomDetail>;
  updateRoom<T = unknown>(roomId: string, patch: JsonObject): Promise<T>;
  addParticipant<T = unknown>(roomId: string, agentId: string): Promise<T>;
  removeParticipant<T = unknown>(roomId: string, agentId: string): Promise<T>;
  /** One page of the transcript, oldest first: the latest `limit`, or those just before / after a Message id. */
  listMessages(roomId: string, page?: { limit?: number; before?: string; after?: string }): Promise<MessageListResponse>;
  sendMessage(roomId: string, input: Omit<SendMessageRequest, "companyId">): Promise<SendMessageResponse>;
  /** The Room's Rounds, newest first, each with its Turns. */
  listRounds(roomId: string): Promise<RoundListResponse>;
  getCosts<T = unknown>(roomId: string): Promise<T>;
  pauseRound<T = unknown>(roomId: string, roundId: string): Promise<T>;
  resumeRound<T = unknown>(roomId: string, roundId: string): Promise<T>;
  stopRound<T = unknown>(roomId: string, roundId: string): Promise<T>;
  closeRoom<T = unknown>(roomId: string): Promise<T>;
  /** Save the Decision record (an empty string clears it); answers with the Room detail. */
  updateDecision(roomId: string, body: Pick<UpdateDecisionRequest, "decisionMd">): Promise<RoomDetail>;
  createWork(roomId: string, body: Omit<CreateWorkRequest, "companyId">): Promise<CreateWorkResponse>;
  addWorkLink(roomId: string, body: { issueId: string }): Promise<WorkLinkView>;
  removeWorkLink(roomId: string, issueId: string): Promise<RemoveWorkLinkResponse>;
  listRoomsForIssue<T = unknown>(issueId: string): Promise<T>;
}

function messagePageQuery(page: { limit?: number; before?: string; after?: string } = {}): Record<string, string> {
  const query: Record<string, string> = {};
  if (page.limit !== undefined) query.limit = String(page.limit);
  if (page.before !== undefined) query.before = page.before;
  if (page.after !== undefined) query.after = page.after;
  return query;
}

export function createBoardroomClient(api: BoardroomApi, companyId: string): BoardroomClient {
  const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;
  const scoped = { companyId };
  return {
    listRooms: () => api.get("/rooms", scoped),
    createRoom: (input) => api.post("/rooms", { ...input, companyId }),
    getRoom: (roomId) => api.get(room(roomId), scoped),
    updateRoom: (roomId, patch) => api.patch(room(roomId), { ...patch, companyId }),
    addParticipant: (roomId, agentId) => api.post(`${room(roomId)}/participants`, { agentId, companyId }),
    removeParticipant: (roomId, agentId) => api.delete(`${room(roomId)}/participants/${encodeURIComponent(agentId)}`, scoped),
    listMessages: (roomId, page) => api.get(`${room(roomId)}/messages`, { ...messagePageQuery(page), ...scoped }),
    sendMessage: (roomId, input) => api.post(`${room(roomId)}/messages`, { ...input, companyId }),
    listRounds: (roomId) => api.get(`${room(roomId)}/rounds`, scoped),
    getCosts: (roomId) => api.get(`${room(roomId)}/costs`, scoped),
    pauseRound: (roomId, roundId) => api.post(`${room(roomId)}/rounds/${encodeURIComponent(roundId)}/pause`, { companyId }),
    resumeRound: (roomId, roundId) => api.post(`${room(roomId)}/rounds/${encodeURIComponent(roundId)}/resume`, { companyId }),
    stopRound: (roomId, roundId) => api.post(`${room(roomId)}/rounds/${encodeURIComponent(roundId)}/stop`, { companyId }),
    closeRoom: (roomId) => api.post(`${room(roomId)}/close`, { companyId }),
    updateDecision: (roomId, body) => api.patch(`${room(roomId)}/decision`, { ...body, companyId }),
    createWork: (roomId, body) => api.post(`${room(roomId)}/work`, { ...body, companyId }),
    addWorkLink: (roomId, body) => api.post(`${room(roomId)}/work-links`, { ...body, companyId }),
    removeWorkLink: (roomId, issueId) => api.delete(`${room(roomId)}/work-links/${encodeURIComponent(issueId)}`, scoped),
    listRoomsForIssue: (issueId) => api.get(`/issues/${encodeURIComponent(issueId)}/rooms`),
  };
}

/** The typed client for `companyId`, over the provided or real API client. */
export function useBoardroomClient(companyId: string): BoardroomClient {
  const api = useBoardroomApi();
  return useMemo(() => createBoardroomClient(api, companyId), [api, companyId]);
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

/** The few fields of the host's agent record the Boardroom UI reads. */
export interface HostAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
}

/** The few fields of the host's issue record the Boardroom UI reads. */
export interface HostIssue {
  id: string;
  identifier: string | null;
  title: string;
}

/** The company's agents from the host board API, for the participant picker. */
export function listCompanyAgents(api: BoardroomApi, companyId: string): Promise<HostAgent[]> {
  return api.getHost<HostAgent[]>(`/companies/${encodeURIComponent(companyId)}/agents`);
}

/** A text search over the company's issues (the host calls them tasks), for the linked-issue picker. */
export function searchCompanyIssues(api: BoardroomApi, companyId: string, text: string, limit = 10): Promise<HostIssue[]> {
  return api.getHost<HostIssue[]>(`/companies/${encodeURIComponent(companyId)}/issues`, { q: text, limit: String(limit) });
}

/** One project's name, for the Room header. */
export function getProjectName(api: BoardroomApi, projectId: string): Promise<{ id: string; name: string }> {
  return api.getHost(`/projects/${encodeURIComponent(projectId)}`);
}
