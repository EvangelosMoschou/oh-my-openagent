/// <reference types="bun-types" />

import { describe, expect, test, mock, afterAll } from "bun:test"

const logMock = mock(() => {})
const dispatchMock = mock(async () => ({ status: "dispatched" }))

mock.module("../../shared/logger", () => ({
  log: logMock,
}))

mock.module("../shared/prompt-async-gate", () => ({
  dispatchInternalPrompt: dispatchMock,
}))

afterAll(() => {
  mock.restore()
})

const { createV4VerificationGateHook } = await import("./hook")

function makeCtx() {
  return {
    client: { session: {} },
    directory: "/tmp/test",
  } as unknown as Parameters<typeof createV4VerificationGateHook>[0]["ctx"]
}

function makeConfig(overrides: Partial<{ enabled: boolean; max_iterations: number }> = {}) {
  return {
    enabled: overrides.enabled ?? false,
    max_iterations: overrides.max_iterations ?? 3,
    evidence_max_chars: 1500,
  }
}

function hookWith(config = makeConfig(), ctx = makeCtx()) {
  return createV4VerificationGateHook({ ctx, config })
}

function registerV4Session(hook: ReturnType<typeof createV4VerificationGateHook>, sessionID: string, modelID = "deepseek/deepseek-v4-pro") {
  hook.event({
    event: {
      type: "message.updated",
      properties: { info: { sessionID, modelID, role: "assistant" } },
    },
  })
}

describe("v4-verification-gate", () => {
  test("#given V4 model session and task tool completion #when tool.execute.after runs #then appends verification reminder", () => {
    // given
    const hook = hookWith()
    const sessionID = "ses_v4"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "", output: "Task completed successfully.", metadata: null }
    hook["tool.execute.after"]({ tool: "task", sessionID, callID: "call_1" }, output)

    // then
    expect(output.output).toContain("V4 VERIFICATION REQUIRED")
    expect(output.output).toContain("94% hallucination rate")
  })

  test("#given V4 model session and call_omo_agent tool completion #when tool.execute.after runs #then appends verification reminder", () => {
    // given
    const hook = hookWith()
    const sessionID = "ses_v4_agent"

    registerV4Session(hook, sessionID, "deepseek/deepseek-v4-flash")

    // when
    const output = { title: "", output: "Agent result.", metadata: null }
    hook["tool.execute.after"]({ tool: "call_omo_agent", sessionID, callID: "call_2" }, output)

    // then
    expect(output.output).toContain("V4 VERIFICATION REQUIRED")
  })

  test("#given non-V4 model session and task tool completion #when tool.execute.after runs #then does NOT append reminder", () => {
    // given
    const hook = hookWith()
    const sessionID = "ses_non_v4"

    registerV4Session(hook, sessionID, "anthropic/claude-sonnet-4-6")

    // when
    const output = { title: "", output: "Task completed.", metadata: null }
    hook["tool.execute.after"]({ tool: "task", sessionID, callID: "call_3" }, output)

    // then
    expect(output.output).toBe("Task completed.")
  })

  test("#given V4 model session and non-delegation tool #when tool.execute.after runs #then does NOT append reminder", () => {
    // given
    const hook = hookWith()
    const sessionID = "ses_v4_other"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "", output: "Read result.", metadata: null }
    hook["tool.execute.after"]({ tool: "read", sessionID, callID: "call_4" }, output)

    // then
    expect(output.output).toBe("Read result.")
  })

  test("#given no cached model for session #when tool.execute.after runs #then does NOT append reminder", () => {
    // given
    const hook = hookWith()

    // when — no event received for this session
    const output = { title: "", output: "Task result.", metadata: null }
    hook["tool.execute.after"]({ tool: "task", sessionID: "ses_unknown", callID: "call_5" }, output)

    // then
    expect(output.output).toBe("Task result.")
  })

  test("#given loop disabled and a failing delegated result #when tool.execute.after runs #then reminder appended but no re-plan dispatch", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: false }))
    const sessionID = "ses_loop_off"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "", output: "Tests failed: 2 of 5 failing.", metadata: null }
    hook["tool.execute.after"]({ tool: "task", sessionID, callID: "call_6" }, output)

    // then
    expect(output.output).toContain("V4 VERIFICATION REQUIRED")
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  test("#given loop enabled and a failing delegated result #when tool.execute.after runs #then dispatches a re-plan prompt with failure evidence", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true }))
    const sessionID = "ses_loop_on"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "", output: "Tests failed: 2 of 5 failing. TypeError at line 42.", metadata: null }
    hook["tool.execute.after"]({ tool: "task", sessionID, callID: "call_7" }, output)

    // then
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    const args = dispatchMock.mock.calls[0]?.[0] as {
      mode: string
      sessionID: string
      source: string
      queueBehavior: string
      input: { body: { parts: Array<{ text?: string }> } }
    }
    expect(args.mode).toBe("async")
    expect(args.sessionID).toBe(sessionID)
    expect(args.source).toBe("v4-verification-gate")
    expect(args.queueBehavior).toBe("defer")
    const promptText = args.input.body.parts[0]?.text ?? ""
    expect(promptText).toContain("failed verification")
    expect(promptText).toContain("TypeError at line 42")
  })

  test("#given loop enabled and a passing delegated result #when tool.execute.after runs #then reminder appended but no re-plan dispatch", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true }))
    const sessionID = "ses_loop_pass"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "", output: "All 5 tests passed. Build green.", metadata: null }
    hook["tool.execute.after"]({ tool: "task", sessionID, callID: "call_8" }, output)

    // then
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  test("#given loop enabled and repeated failures #when iteration cap is reached #then no further re-plan dispatch", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true, max_iterations: 2 }))
    const sessionID = "ses_loop_cap"

    registerV4Session(hook, sessionID)

    // when — three failing results, cap is 2
    for (let i = 0; i < 3; i += 1) {
      const output = { title: "", output: `Attempt ${i + 1} failed: test suite error.`, metadata: null }
      hook["tool.execute.after"]({ tool: "task", sessionID, callID: `call_cap_${i}` }, output)
    }

    // then — exactly 2 dispatches, the 3rd escalates
    expect(dispatchMock).toHaveBeenCalledTimes(2)
  })

  test("#given a dsh agent completion #when tool.execute.after runs #then reminder appended and the tool is treated as delegated", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true }))
    const sessionID = "ses_dsh"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "dsh agent", output: "Agent result.", metadata: { stopReason: "end_turn" } }
    hook["tool.execute.after"]({ tool: "call_dsh_agent", sessionID, callID: "call_dsh_1" }, output)

    // then
    expect(output.output).toContain("V4 VERIFICATION REQUIRED")
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  test("#given a dsh agent completion with a failure stop reason #when tool.execute.after runs #then dispatches a re-plan prompt", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true }))
    const sessionID = "ses_dsh_fail"

    registerV4Session(hook, sessionID)

    // when — clean text but failing metadata
    const output = { title: "dsh agent", output: "Done.", metadata: { stopReason: "error" } }
    hook["tool.execute.after"]({ tool: "call_dsh_agent", sessionID, callID: "call_dsh_2" }, output)

    // then
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    const args = dispatchMock.mock.calls[0]?.[0] as { source: string }
    expect(args.source).toBe("v4-verification-gate")
  })

  test("#given a dsh agent completion with a non-zero exit code #when tool.execute.after runs #then dispatches a re-plan prompt", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true }))
    const sessionID = "ses_dsh_exit"

    registerV4Session(hook, sessionID)

    // when — clean text but failing exit code metadata
    const output = { title: "dsh agent", output: "All done.", metadata: { exitCode: 1 } }
    hook["tool.execute.after"]({ tool: "call_dsh_agent", sessionID, callID: "call_dsh_3" }, output)

    // then
    expect(dispatchMock).toHaveBeenCalledTimes(1)
  })

  test("#given a dsh agent completion with clean metadata #when tool.execute.after runs #then no re-plan dispatch", () => {
    // given
    dispatchMock.mockClear()
    const hook = hookWith(makeConfig({ enabled: true }))
    const sessionID = "ses_dsh_clean"

    registerV4Session(hook, sessionID)

    // when
    const output = { title: "dsh agent", output: "All green.", metadata: { stopReason: "end_turn", exitCode: 0 } }
    hook["tool.execute.after"]({ tool: "call_dsh_agent", sessionID, callID: "call_dsh_4" }, output)

    // then
    expect(dispatchMock).not.toHaveBeenCalled()
  })
})
