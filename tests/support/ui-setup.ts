import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { sdkUi } from "./sdk-ui-mock.js";

afterEach(() => {
  cleanup();
  sdkUi.reset();
});
