import type { PluginApiResponse } from "@paperclipai/plugin-sdk";

/**
 * One error shape for every route: `{ error: <code>, message }`, plus optional `details`.
 * Routes must return their status: an error thrown out of `onApiRequest` loses it and becomes 502
 * at the host, so the dispatcher catches `ApiError` and turns it into a response.
 */
export type ApiErrorStatus = 400 | 403 | 404 | 409 | 422 | 500 | 501;

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toResponse(): PluginApiResponse {
    const body: ApiErrorBody = { error: this.code, message: this.message };
    if (this.details) body.details = this.details;
    return { status: this.status, body };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, "invalid_request", message, details);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const roomNotFound = () => new ApiError(404, "room_not_found", "Room not found");
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(422, code, message, details);

export function ok<T>(body: T, status = 200): PluginApiResponse {
  return { status, body };
}
