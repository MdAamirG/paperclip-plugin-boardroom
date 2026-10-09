import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { badRequest } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The host passes ids to Postgres as uuids; a malformed one would raise a cast error, so check first. */
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export function readBody(input: PluginApiRequestInput): Record<string, unknown> {
  const body = input.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("The request body must be a JSON object");
  return body as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string") throw badRequest(`"${field}" must be a string`, { field });
  const trimmed = value.trim();
  if (!trimmed) throw badRequest(`"${field}" must not be empty`, { field });
  if (trimmed.length > maxLength) throw badRequest(`"${field}" must be at most ${maxLength} characters`, { field });
  return trimmed;
}

/** A string, or `null` when the field is absent or null. */
export function optionalId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`"${field}" must be a string`, { field });
  return value;
}
