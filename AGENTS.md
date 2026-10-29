|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning
|Required Tools:codegraph (code structure, call paths, impact)|context7 (3rd-party docs)|sequential-thinking (decisions)
|Language Policy:Chinese for Q&A|English for code/docs/tech discussions
|Compression Rule:Follow .agents/skills/scoped-agentsmd/references/AGENTS-compression-guide.md (pipe-index format, concise, no prose/code blocks)
|Scope:repo-root
|Overview:opencode-acp is a TypeScript ESM OpenCode V2 server plugin for model-driven Active Context Pruning|package:@infituit/opencode-acp|runtime:Node.js|package-manager:npm
|Structure:./:{index.ts,lib,tests,scripts,docs,.github,package.json,tsconfig.json,tsup.config.ts,acp.schema.json}
|Where to look:plugin entry:index.ts→lib/v2/plugin.ts|V2 message conversion:lib/v2/messages.ts|hook handlers:lib/hooks.ts|configuration:lib/config.ts,lib/config-validation.ts|logging:lib/logger.ts
|Where to look:compression:lib/compress|message pipeline:lib/messages|session state:lib/state|prompt rendering:lib/prompts|slash commands:lib/commands|GC:lib/gc
|Where to look:verification:VERIFICATION.md,tests/v2-messages.test.ts,scripts/e2e/{run-e2e.sh,README.md}|user docs:README.md,acp.schema.json|release:docs/developer/release.md
|Architecture:OpenCode V2→index.ts→AcpV2Plugin.setup→context hook and tool/command transforms→message conversion, pruning and prompt injection→compress/decompress→per-session state persisted via ctx.storage
|Architecture:compression pipeline:{raw messages→T1 capture→T2 distill→T3 condense}|GC is a last-resort safety net, not the primary context strategy
|State:session state is per-session and persisted under OpenCode data storage|message refs and compression block IDs are compatibility-sensitive
|Config:ACP-owned acp.json(c):global→OPENCODE_CONFIG_DIR→project .opencode|later layers override earlier layers|loaded in plugin setup; restart OpenCode after ACP config changes|do not infer OpenCode config reload behavior from ACP config
|Compatibility:opencode-acp 2.x targets OpenCode >=2.1.4 <3 and the V2 plugin API|do not add OpenCode 1.x compatibility paths, dual entries, or legacy-state adapters unless the request explicitly changes this contract|treat V1 docs and code paths as migration input only
|Conventions:before changes inspect the owning module and at least one analogous implementation|prefer existing helpers and narrow changes|do not silently choose materially different behavior
|Conventions:preserve exported API, persisted state, message-ref/block-ID, prompt, and configuration compatibility unless the request explicitly changes the contract|use official https://opencode.ai/v2/docs for OpenCode V2 behavior, not V1 docs
|Conventions:TypeScript strict mode|ESM imports|format with Prettier
|Anti-patterns:no speculative abstractions or dependencies|no parallel compression/state/conversion paths|no hand-editing generated dist output|no unrelated refactor or formatting churn
|Commands:npm run typecheck|npm run build|npm run format:check|npm run check:package|./scripts/dev-deploy.sh --check|./scripts/e2e/run-e2e.sh
|Verification:check changed paths and git diff|run the smallest relevant command set|report known failures without masking or rewriting them
|Skills:scoped subtree AGENTS.md→.agents/skills/scoped-agentsmd/SKILL.md|project-specific reusable workflows belong under .agents/skills|generic language guidance is supplementary, not a replacement for local contracts
