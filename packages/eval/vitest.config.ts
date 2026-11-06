import { defineConfig } from "vitest/config";

// Cloned repositories under .cache carry their own test suites; only ours run here.
// The intel backtest tests analyze real fixture repositories and need more than the 5 s default on a cold machine.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 } });
