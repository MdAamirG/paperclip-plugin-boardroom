import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { buildApiRoutes } from "./api/route-table.js";
import { BOARDROOM_PLUGIN_ID, BOARDROOM_ROUTE_PATH } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: BOARDROOM_PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0-dev.0",
  displayName: "Boardroom",
  description:
    "Human-led discussion Rooms where a board operator and chosen agents work through one decision, then turn it into ordinary Paperclip work.",
  author: "MdAamirG",
  categories: ["ui"],
  // The 0.x list from the spec. Declare only capabilities that current hosts know:
  // a manifest with an unknown capability fails to install.
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agents.read",
    // Not in the spec list: Room creation must check that the chosen project is in the company.
    "projects.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "access.members.read",
    "issues.read",
    "issues.create",
    "issue.documents.write",
    "activity.log.write",
    "events.subscribe",
    "jobs.schedule",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "boardroom",
    migrationsDir: "migrations",
    // `companies` is listed so every plugin table can reference public.companies(id) ON DELETE CASCADE.
    coreReadTables: ["companies", "heartbeat_runs", "cost_events", "agents"],
  },
  apiRoutes: buildApiRoutes(),
  ui: {
    slots: [
      {
        type: "page",
        id: "boardroom-page",
        displayName: "Boardroom",
        exportName: "BoardroomPage",
        routePath: BOARDROOM_ROUTE_PATH,
      },
      {
        type: "sidebar",
        id: "boardroom-sidebar",
        displayName: "Boardroom",
        exportName: "BoardroomSidebarLink",
      },
    ],
  },
};

export default manifest;
