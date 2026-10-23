# Notes for AI coding agents

[CONTRIBUTING.md](CONTRIBUTING.md) applies to you too. The parts that matter most when working here without a human watching every step:

- Run `npm test` and `npm run typecheck` before saying a change is done. Report failures as failures.
- Node 24 runs TypeScript directly. Follow the import style of the package you are in; do not add build steps.
- Stay inside the package you are changing. If you need something another package does not export, change its contract deliberately and say so, instead of reaching into its internals.
- Do not add dependencies, CI changes, or new top-level files without an issue or an explicit request.
- Keep README.md short. Details go in `docs/` or the package's own docs.
- gitgoblin's commitments to other projects in [docs/etiquette.md](docs/etiquette.md) are requirements. Never add a path that publishes, pushes, or comments without human approval.
