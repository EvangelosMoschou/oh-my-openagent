# Pro-Flash loop-back on the v4-verification-gate

**WHAT WAS TESTED:** the v4-verification-gate now optionally dispatches a re-plan
continuation prompt to the parent session when a delegated (task/call_omo_agent)
result carries failure signals, gated by the new `pro_flash_loop` config (default
off, max_iterations cap, evidence truncation). Dispatch goes through
`dispatchInternalPrompt` (async, queueBehavior defer, source
"v4-verification-gate") — the prompt-async-gate sanctioned path, never raw
promptAsync.

**WHAT WAS OBSERVED:**
1. `bun test packages/omo-opencode/src/hooks/v4-verification-gate/` -> 9 pass / 0
   fail. Covers: reminder append (V4 + task/call_omo_agent), non-V4 and
   non-delegation no-ops, no-cached-model no-op, loop disabled -> no dispatch,
   loop enabled + failing result -> exactly one dispatch with failure evidence in
   the prompt body, loop enabled + passing result -> no dispatch, iteration cap
   (max_iterations=2) -> exactly 2 dispatches then escalation.
2. `bun test packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts`
   -> 10 pass / 0 fail (raw-promptAsync invariant still pinned; the gate uses the
   gate).
3. `bun test packages/omo-opencode/src/config/` -> 141 pass / 0 fail (new
   pro_flash_loop schema parses).
4. `bun test packages/omo-opencode/src/plugin/hooks/create-tool-guard-hooks.test.ts`
   -> 1 pass / 0 fail (hook wiring intact).
5. `bun run typecheck` -> exit 0 (root + all packages, after merging latest dev
   which resolved the memory-core workspace drift).

**WHY IT IS ENOUGH:** the loop-back is pure hook logic over the existing
prompt-async-gate; unit tests pin every branch (enabled/disabled, fail/pass,
cap reached). The typecheck + audit + config suites prove the schema, wiring, and
dispatch-invariant are intact.

**WHAT WAS OMITTED:** a live end-to-end run driving a real DeepSeek V4 Pro session
(paid API, ~10 min). The dispatch contract is proven by the prompt-async-gate
unit path and the audit test; live behavior reuses the already-validated
dispatchInternalPrompt machinery.

# ALSO ON THIS BRANCH
- Merged latest dev (391 commits) — resolves memory-core workspace drift and keeps
  the branch mergeable; regenerated nothing (no bundle-touching changes here).

# UPDATE: A + B — gate watches call_dsh_agent + metadata failure signals

**WHAT WAS TESTED:** (A) the gate's DELEGATION_TOOLS now includes
call_dsh_agent, so dsh results get the same verification treatment as
task/call_omo_agent. (B) the gate now treats tool metadata as failure
evidence, not just text heuristics: stopReason error/refusal/cancelled and
non-zero exitCode both trigger the re-plan dispatch even when the output text
is clean.

**WHAT WAS OBSERVED:**
1. `bun test packages/omo-opencode/src/hooks/v4-verification-gate/` -> 13 pass
   / 0 fail. New tests: call_dsh_agent is a delegated tool (reminder appended,
   no dispatch on clean metadata); stopReason=error with clean text -> dispatch;
   exitCode=1 with clean text -> dispatch; end_turn + exitCode 0 -> no dispatch.
2. `bun run typecheck` -> exit 0.
