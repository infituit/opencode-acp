# WORKLOG — emergency truncation kill switch

## Changes

1. **lib/config.ts**
   - `CompressConfig`: added `emergencyTruncation?: boolean` (after
     `completionReserveTokens`), doc comment references #485.
   - Defaults: `emergencyTruncation: false` in the compress defaults block.
   - Merge function: `emergencyTruncation: override.emergencyTruncation ??
     base.emergencyTruncation`. Field flows through the
     `CompressOverridableConfig` cascade automatically (not in the Omit list).

2. **lib/config-validation.ts**
   - `VALID_CONFIG_KEYS` += `compress.emergencyTruncation`.
   - Boolean type check (expected `"boolean"`), placed before the
     completionReserveTokens numeric checks.
   - `OVERRIDE_FIELD_TYPES` += `emergencyTruncation: "boolean"` (enables
     provider/model override validation).

3. **lib/hooks.ts** (~line 421, message-transform pipeline)
   - Wrapped BOTH `truncateLargeToolOutputs(...)` and
     `enforceContextBudget(state, config, logger, output.messages)` in
     `if (config.compress?.emergencyTruncation === true)`. Comment explains
     the #485 oscillation. `injectMessageIds` stays outside the gate (ID
     assignment is orthogonal and required in both modes).

4. **dcp.schema.json**
   - `emergencyTruncation` (boolean, default false) at all 4 relevant spots:
     compress root properties, provider-override level, model-override level,
     defaults block. JSON validity verified.

5. **CONFIGURATION.md / CONFIGURATION.zh-CN.md**
   - New `#### compress.emergencyTruncation` section (Type/Default/Status +
   full rationale: view-only truncation oscillates; flips invalidate prefix
   cache; retry storm can kill the backend; off = loud failure instead of
   silent mutation).

6. **tests/emergency-truncation-switch.test.ts** (NEW, 5 tests)
   - 3 config-validation tests (known key / accepts booleans / rejects
     non-boolean with key + expected assertions).
   - 2 e2e pipeline tests via `createChatMessageTransformHandler` +
     `tests/registry-stub.ts`: default off → oversized old tool output
     survives byte-identical (prefix match + no truncation marker; the
     appended `<dcp-message-id>` tag from injectMessageIds is the only legal
     addition); opt-in on → same scenario produces the truncation marker.

7. **tests/e2e-message-transform.test.ts**
   - "candidate planning uses pre-truncation tool output": now sets
     `config.compress.emergencyTruncation = true` — the test pins truncation
     behavior itself, which is opt-in as of #485.

## Debugging notes / lessons

- **BILLION_CONTEXT_PROXY env noise**: running `npm test` in a shell where
  `BILLION_CONTEXT_PROXY` is set produces 88 spurious failures ("ACP is
  disabled in this process — billion-context launcher mode"). Run
  `env -u BILLION_CONTEXT_PROXY npm test` in this environment.
- **modelContextLimit invalidation**: seeding `state.modelContextLimit` in a
  test is NOT enough — hooks.ts (#312 fallback) invalidates it when the user
  message names a model the registry catalog cannot resolve and the state's
  model identity differs. Fix: `registry.recordModelLimit("test-provider",
  "test-model", 40_000)` in the test setup.
- **Strict equality on tool output is too strict**: `injectMessageIds` →
  `appendToAllToolParts` legitimately appends the `<dcp-message-id>` tag
  AFTER the truncation stage. Assert `startsWith(fullContent)` + absence of
  the truncation marker instead.
- Scenario tuning for the opt-in test: window 40_000 → budget
  40_000−32_768=7_232; last token-bearing assistant input 7_900 → estimate
  ≈7,980 > budget → phase-1 truncation only (final ≈6,520, phase 2 skipped);
  GC threshold min(100%×40k, 40k−16,384)=23,616 stays idle.

## Verification

- `npm run typecheck` ✅
- `env -u BILLION_CONTEXT_PROXY npm test` → 1379/1379 pass ✅
- `npm run build` ✅ (dist/index.js 514.73 KB)
- `scripts/ci/check-pr.sh` — to be run before PR creation
