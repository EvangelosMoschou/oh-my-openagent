import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
  query?: {
    directory: string
  }
}

type SessionMessageStub = {
  info?: {
    role?: string
    finish?: string
    time?: { created?: number; completed?: number }
  }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; state?: { status?: string } }>
}

const FINAL_WAKE = [
  "<system-reminder>",
  "[BACKGROUND TASK COMPLETED]",
  "[ALL BACKGROUND TASKS COMPLETE]",
  "",
  "**Completed:**",
  "- `task-a`: task A",
  "",
  'Use `background_output(task_id="<id>")` to retrieve each result.',
  "</system-reminder>",
].join("\n")

const PARENT_MESSAGES: SessionMessageStub[] = [
  {
    info: { role: "user", time: { created: 80_000 } },
    parts: [{ type: "text", text: "start work" }],
  },
  {
    info: { role: "assistant", finish: "stop", time: { created: 90_000 } },
    parts: [{ type: "text", text: "parent output" }],
  },
]

// A parent turn whose latest assistant message blocks internal prompts with a
// stale tool call (D1 trigger: toolWaitDecision.defer).
const STALE_TOOL_CALL_MESSAGES: SessionMessageStub[] = [
  {
    info: { role: "user", time: { created: 80_000 } },
    parts: [{ type: "text", text: "start work" }],
  },
  {
    info: { role: "assistant", finish: "tool-calls", time: { created: 99_500 } },
    parts: [{ type: "tool", state: { status: "running" } }],
  },
]

function createNotifier(args: {
  sessionStatuses: Record<string, { type: string }>
  messagesProvider: () => SessionMessageStub[]
  parentActivityWindowMs?: number
}): {
  notifier: ParentWakeNotifier
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1" })
  Object.assign(client.session, {
    messages: async () => ({ data: args.messagesProvider() }),
    status: async () => ({ data: args.sessionStatuses }),
    promptAsync: async (call: PromptAsyncCall) => {
      promptAsyncCalls.push(call)
      return { data: {} }
    },
    abort: async () => ({ data: {} }),
  })

  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 5_000,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 5_000,
      userMessageInProgressWindowMs: 2_000,
      parentSessionActivityInProgressWindowMs: args.parentActivityWindowMs ?? 0,
    },
  )

  return { notifier, promptAsyncCalls }
}

function queueAgedWake(notifier: ParentWakeNotifier, sessionID = "parent-1"): void {
  notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)
  const wake = notifier.getPendingParentWakes().get(sessionID)
  if (!wake) {
    throw new Error("expected pending wake")
  }
  wake.queuedAt = Date.now() - 120_000
}

function releaseParentWakeHold(sessionID: string): void {
  releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
}

afterEach(() => {
  releaseAllPromptAsyncReservationsForTesting()
})

describe("parent wake reply-required retention (#6546 D2)", () => {
  test("#given a retained reply wake was admitted as noReply #when the parent produces output after admission #then the reply-required wake is NOT dropped", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => PARENT_MESSAGES,
      parentActivityWindowMs: 180_000,
    })
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)
    notifier.recordParentSessionActivity("parent-1")

    try {
      // when — fresh parent activity admits the wake as noReply, retained
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.noReplyAdmittedAt).toBeDefined()

      // when — the parent produces unrelated assistant output after admission,
      // then the flush runs again
      PARENT_MESSAGES.push({
        info: { role: "assistant", finish: "stop", time: { created: 200_000 } },
        parts: [{ type: "text", text: "after admission output" }],
      })
      now = 220_000
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then — the reply-required wake survives the consumed-admission drop
      // (D2 regression: it must not be deleted)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })
})

describe("parent wake stale tool-call defer ceiling (#6546 D1)", () => {
  test("#given a reply wake ages past the ceiling while a stale tool call blocks #then it force-dispatches the reply instead of deferring forever", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => STALE_TOOL_CALL_MESSAGES,
    })
    queueAgedWake(notifier)

    try {
      // when
      await notifier.flushPendingParentWake("parent-1")

      // then — a reply is dispatched (noReply false) even though the history
      // tool-wait decision would normally defer (D1 regression)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).not.toBe(true)
      expect(notifier.getPendingParentWakes().has("parent-1")).toBe(false)
    } finally {
      notifier.shutdown()
    }
  })
})
