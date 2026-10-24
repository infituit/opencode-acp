|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning
|Required Tools:codegraph (code structure, call paths, impact)|context7 (3rd-party docs)|sequential-thinking (decisions)
|Language Policy:Chinese for Q&A|English for code/docs/tech discussions
|Compression Rule:Follow .agents/skills/scoped-agentsmd/references/AGENTS-compression-guide.md (pipe-index format, concise, no prose/code blocks)
|Scope:repo-root
|Overview:opencode-acp is a TypeScript ESM OpenCode V1 plugin for model-driven Active Context Pruning|package:opencode-acp|runtime:Node.js|package-manager:npm
|Structure:./:{index.ts,lib,scripts,.github,package.json,tsconfig.json,tsup.config.ts,dcp.schema.json}
|Where to look:plugin wiring:index.ts|hook lifecycle:lib/hooks.ts|configuration:lib/config.ts,lib/config-validation.ts|logging:lib/logger.ts
|Where to look:compression:lib/compress|message pipeline:lib/messages|session state:lib/state|prompt rendering:lib/prompts|slash commands:lib/commands|GC:lib/gc
|Where to look:runtime verification:scripts/e2e/run-e2e.sh and scripts/e2e/README.md|user docs:README.md,README.zh-CN.md,CONFIGURATION.md,CONFIGURATION.zh-CN.md
|Architecture:OpenCode session→index.ts hooks/tools→message transform and prompt injection→compress/decompress→persisted per-session state
|Architecture:compression pipeline:{raw messages→T1 capture→T2 distill→T3 condense}|GC is a last-resort safety net, not the primary context strategy
|State:session state is per-session and persisted under OpenCode data storage|message refs and compression block IDs are compatibility-sensitive
|Config:global→OPENCODE_CONFIG_DIR→project .opencode/acp.jsonc|later layers override earlier layers|restart OpenCode after config changes
|Compatibility:opencode-acp targets OpenCode 1.x V1 plugin API|OpenCode 2.x work belongs to billion-context, not this repository|verify a reported path is live V1 code before redirecting
|Conventions:before changes inspect the owning module and at least one analogous implementation|prefer existing helpers and narrow changes|do not silently choose materially different behavior
|Conventions:preserve exported API, persisted state, message-ref/block-ID, prompt, and configuration compatibility unless the request explicitly changes the contract
|Conventions:TypeScript strict mode|ESM imports|format with Prettier|runtime verification uses isolated OpenCode E2E scenarios
|Anti-patterns:no speculative abstractions or dependencies|no parallel compression/state/conversion paths|no hand-editing generated dist output|no unrelated refactor or formatting churn
|Verification:behavior changes require runtime verification when practical|run typecheck/build first|use scripts/e2e for full lifecycle checks when the change crosses hooks and persistence
|Commands:npm run typecheck|npm run build|npm run format:check|npm run check:package|./scripts/dev-deploy.sh --check|./scripts/e2e/run-e2e.sh
|Verification:check changed paths and git diff|run the smallest relevant command set|report known failures without masking or rewriting them
|Skills:scoped subtree AGENTS.md→.agents/skills/scoped-agentsmd/SKILL.md|project-specific reusable workflows belong under .agents/skills|generic language guidance is supplementary, not a replacement for local contracts
