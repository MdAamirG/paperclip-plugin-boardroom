import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { BOARDROOM_NAMESPACE, createBoardroomHarness, type BoardroomHarness } from "./support/harness.js";

/** The 0.x capability list from the spec ("Capabilities (0.x)"), and nothing else. */
const CAPABILITIES_0X = [
  "database.namespace.migrate",
  "database.namespace.read",
  "database.namespace.write",
  "agents.read",
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
] as const;

/** Capabilities that only the later release may declare (they need a newer host). */
const LATER_RELEASE_CAPABILITIES = [
  "agent.sessions.send_human_attributed",
  "activity.log.write_human_attributed",
] as const;

describe("built manifest", () => {
  let outdir: string;
  let built: PaperclipPluginManifestV1;

  beforeAll(async () => {
    // Build the manifest exactly as `pnpm build` does, so the test checks the shipped artifact.
    outdir = await mkdtemp(path.join(os.tmpdir(), "boardroom-manifest-"));
    const presets = createPluginBundlerPresets({ outdir });
    await esbuild.build({ ...presets.esbuild.manifest, sourcemap: false, logLevel: "silent" });
    const mod = (await import(pathToFileURL(path.join(outdir, "manifest.js")).href)) as {
      default: PaperclipPluginManifestV1;
    };
    built = mod.default;
  });

  afterAll(async () => {
    await rm(outdir, { recursive: true, force: true });
  });

  it("parses with the host's manifest schema", () => {
    const result = pluginManifestV1Schema.safeParse(built);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("uses the author-namespaced id, API version 1 and the ui category", () => {
    expect(built.id).toBe("mdaamirg.boardroom");
    expect(built.apiVersion).toBe(1);
    expect(built.displayName).toBe("Boardroom");
    expect(built.categories).toEqual(["ui"]);
  });

  it("declares exactly the 0.x capability list", () => {
    expect([...built.capabilities].sort()).toEqual([...CAPABILITIES_0X].sort());
    for (const capability of LATER_RELEASE_CAPABILITIES) {
      expect(built.capabilities).not.toContain(capability);
    }
  });

  it.each(LATER_RELEASE_CAPABILITIES)("would fail to install on a current host if it declared %s", (capability) => {
    const withLater = { ...built, capabilities: [...built.capabilities, capability] };
    expect(pluginManifestV1Schema.safeParse(withLater).success).toBe(false);
  });

  it("declares the plugin database namespace and its core read tables", () => {
    expect(built.database).toEqual({
      namespaceSlug: "boardroom",
      migrationsDir: "migrations",
      coreReadTables: ["heartbeat_runs", "cost_events", "agents"],
    });
  });

  it("declares worker and UI entrypoints and the page and sidebar slots", () => {
    expect(built.entrypoints).toEqual({ worker: "./dist/worker.js", ui: "./dist/ui" });
    const slots = built.ui?.slots ?? [];
    expect(slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "page", routePath: "boardroom", exportName: "BoardroomPage" }),
        expect.objectContaining({ type: "sidebar", exportName: "BoardroomSidebarLink" }),
      ]),
    );
  });
});

describe("worker", () => {
  let harness: BoardroomHarness;

  beforeAll(async () => {
    harness = await createBoardroomHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("logs what it knows about the host at startup", () => {
    const startup = harness.logs.find((entry) => entry.message === "Boardroom worker started");
    expect(startup?.meta).toMatchObject({
      pluginId: "mdaamirg.boardroom",
      manifestApiVersion: 1,
      databaseNamespace: BOARDROOM_NAMESPACE,
      // SDK 2026.1005.0 consumes the host version in the initialize RPC and does not expose it on ctx.
      hostVersion: null,
    });
  });

  it("answers 404 for every route until routes are built", async () => {
    const company = await harness.seedCompany();
    const response = await harness.request("rooms.list", {
      method: "GET",
      path: "/rooms",
      companyId: company.id,
      actor: company.members.owner,
    });
    expect(response.status).toBe(404);
  });
});
