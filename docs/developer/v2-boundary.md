# OpenCode V2 integration boundary

## Architectural direction

`src/v2/` is the target integration boundary between OpenCode V2 and ACP's business capabilities. It owns host-specific registration, message conversion, lifecycle handling, and request orchestration. Here, V2 refers to the OpenCode plugin API and runtime contract, not a separate agent communication protocol.

This boundary is adopted incrementally across multiple refactoring rounds. The layout below describes the target ownership, not a claim that all existing code already conforms to it.

## Responsibility split

| Responsibility                                                                                        | Target location                                     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Plugin registration, dependency assembly, and lifecycle binding                                       | `src/v2/plugin.ts`                                  |
| Conversion between OpenCode messages and ACP's internal representation                                | `src/v2/messages.ts`                                |
| Unified handler exports                                                                               | `src/v2/hooks.ts`                                   |
| Host-request guards and orchestration of ACP capabilities                                             | `src/v2/hooks/`                                     |
| Compression, message-processing rules, state management, prompt rendering, and command business logic | Their existing capability modules outside `src/v2/` |

The integration layer decides when and in what order ACP capabilities run for a host request, and how their results are returned to OpenCode. The capability modules implement the operations themselves.

For example, the message handler coordinates state synchronization, filtering, pruning, and nudge injection. The pruning and nudge algorithms remain in `src/messages/`; they do not move into `src/v2/` merely because the handler calls them.

The intended dependency direction is `src/v2/` → ACP capability modules. Business algorithms should not import `src/v2/hooks` to invoke host handlers. This direction is a convergence goal, not an assertion that all existing host coupling has already been removed.

## Hooks ownership

Keep a single export entry and separate implementations:

```text
src/v2/
├── plugin.ts
├── messages.ts
├── hooks.ts
└── hooks/
    ├── system.ts
    ├── messages.ts
    ├── command.ts
    ├── text.ts
    └── event.ts
```

The three message-related locations have distinct roles:

- `src/v2/messages.ts`: host message format conversion.
- `src/v2/hooks/messages.ts`: per-request orchestration.
- `src/messages/`: message-processing rules and algorithms.

## Incremental convergence

The hooks relocation is a file-and-import change: move the unified export entry and handler implementations under `src/v2/`, then update their callers, tests, and benchmark imports. Do not retain a root-level forwarding entry; hooks are not a published package export.

Preserve handler signatures, function bodies, and execution order during that relocation. In particular, keep command interception, internal-agent guards, message-transform ordering, and compression timing behavior unchanged. Do not combine the move with new adapter interfaces, a generic pipeline framework, or a business-logic rewrite.

Further convergence work is scoped separately rather than bundled into the hooks relocation. Public APIs, configuration, persisted state, message references, and compression block IDs remain unchanged by this structural work.
