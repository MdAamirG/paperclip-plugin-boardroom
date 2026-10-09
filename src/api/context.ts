import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import type { Actor } from "./access.js";

/** What every route handler receives. */
export interface RouteContext {
  ctx: PluginContext;
  input: PluginApiRequestInput;
  /** The verified caller and their company role; the company is `input.companyId`. */
  actor: Actor;
}

export type RouteHandler = (route: RouteContext) => Promise<PluginApiResponse>;
