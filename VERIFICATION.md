# Verification Guide — opencode-acp

The project validates the shipped plugin through its build, package, and runtime loading paths rather than isolated mock tests.

## Static and package checks

```bash
npm run typecheck
npm run check:package
```

`check:package` builds the bundle and verifies the published file set plus the runtime import graph.

## Real OpenCode loading

Run the scenario-based runtime verification with an `opencode` binary and Bun available:

```bash
./scripts/e2e/run-e2e.sh
```

The runner builds `dist/`, configures an isolated OpenCode home to load the local bundle, starts a fake LLM endpoint, runs real multi-turn `opencode run` sessions, and verifies the resulting ACP state files.

For local development, deploy the current bundle to OpenCode's plugin cache:

```bash
./scripts/dev-deploy.sh
```

Restart OpenCode after deployment so it loads the new bundle.
