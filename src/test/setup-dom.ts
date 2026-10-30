import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only cleans up automatically when Vitest globals are on.
afterEach(() => {
  cleanup();
  // Independent tests represent separate tabs; remounts within a test retain recovery drafts.
  sessionStorage.clear();
});

// jsdom has no layout, so nothing ever resizes.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
