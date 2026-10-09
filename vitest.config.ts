import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdkUiMock = fileURLToPath(new URL("./tests/support/sdk-ui-mock.tsx", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "worker",
          environment: "node",
          include: ["tests/**/*.spec.ts"],
          // PGlite boots a WASM Postgres per harness; give it room on slow machines.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // In the host, `@paperclipai/plugin-sdk/ui` is provided by the Paperclip app at runtime.
        // UI tests swap it for a controllable mock (tests/support/sdk-ui-mock.tsx).
        resolve: {
          alias: [{ find: /^@paperclipai\/plugin-sdk\/ui$/, replacement: sdkUiMock }],
        },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/**/*.spec.tsx"],
          setupFiles: ["tests/support/ui-setup.ts"],
        },
      },
    ],
  },
});
