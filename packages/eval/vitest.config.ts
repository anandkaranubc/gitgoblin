import { defineConfig } from "vitest/config";

// Cloned repositories under .cache carry their own test suites; only ours run here.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
