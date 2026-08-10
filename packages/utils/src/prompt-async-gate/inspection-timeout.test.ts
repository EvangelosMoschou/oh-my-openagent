import { afterEach, describe, expect, test } from "bun:test"
import { dispatchInternalPrompt } from "../prompt-async-gate"
import {
  _setPromptGateMessagesFetchTimeoutMsForTesting,
  resetPromptGateTimingForTesting,
} from "./timing"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../prompt-async-gate"

type PromptAsyncCall = {
  path: { id: string }
  body: { parts?: unknown[] }
  query?: { directory: string }
}

function createClient(args: {
  sessionStatus?: () => Promise<unknown>
  messages: () => Promise<unknown>
  promptAsync: (call: PromptAsyncCall) => Promise<unknown>
}): {
  client: {
    session: {
      status: () => Promise<unknown>
      messages: () => Promise<unknown>
      promptAsync: (call: PromptAsyncCall) => Promise<unknown>
    }
  }
} {
  const client = {
    session: {
      status: args.sessionStatus ?? (async () => ({ data: {} })),
      messages: args.messages,
      promptAsync: args.promptAsync,
    },
  }
  return { client }
}

afterEach(() => {
  resetPromptGateTimingForTesting()
  releaseAllPromptAsyncReservationsForTesting()
})

describe("prompt-async-gate inspection timeout (#6534)", () => {
  test("#given the session.messages inspection stalls past the gate timeout #when dispatching #then it returns inconclusive, not active", async () => {
    // given
    _setPromptGateMessagesFetchTimeoutMsForTesting(50)
    let promptAsyncCalls = 0
    const { client } = createClient({
      sessionStatus: async () => ({ data: {} }),
      messages: () => new Promise(() => {}), // never resolves
      promptAsync: async () => {
        promptAsyncCalls += 1
        return { data: {} }
      },
    })

    try {
      // when
      const result = await dispatchInternalPrompt({
        mode: "async",
        client: client as never,
        sessionID: "ses-inspection-timeout",
        source: "test",
        settleMs: 0,
        queueBehavior: "defer",
        input: {
          path: { id: "ses-inspection-timeout" },
          body: { parts: [{ type: "text", text: "hi" }] },
          query: { directory: "/tmp" },
        },
      })

      // then — a stalled inspection must not be classified as "active"
      expect(result.status).not.toBe("active")
      expect(result.status).toBe("inconclusive")
      expect(promptAsyncCalls).toBe(0)
    } finally {
      releasePromptAsyncReservation("ses-inspection-timeout", "test")
    }
  })

  test("#given a verified idle session with no blocking assistant turn #when dispatching #then it dispatches", async () => {
    // given
    _setPromptGateMessagesFetchTimeoutMsForTesting(50)
    let promptAsyncCalls = 0
    const { client } = createClient({
      sessionStatus: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        promptAsyncCalls += 1
        return { data: {} }
      },
    })

    try {
      // when
      const result = await dispatchInternalPrompt({
        mode: "async",
        client: client as never,
        sessionID: "ses-idle-dispatch",
        source: "test",
        settleMs: 0,
        queueBehavior: "defer",
        input: {
          path: { id: "ses-idle-dispatch" },
          body: { parts: [{ type: "text", text: "hi" }] },
          query: { directory: "/tmp" },
        },
      })

      // then
      expect(result.status).toBe("dispatched")
      expect(promptAsyncCalls).toBe(1)
    } finally {
      releasePromptAsyncReservation("ses-idle-dispatch", "test")
    }
  })
})
