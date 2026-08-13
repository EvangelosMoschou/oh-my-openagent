import type { PluginContext } from "../../plugin/types"
import { log } from "../../shared/logger"
import { createInternalAgentContinuationTextPart } from "@oh-my-opencode/utils/internal-initiator-marker"
import { dispatchInternalPrompt } from "../shared/prompt-async-gate"
import type { ProFlashLoopConfig } from "../../config/schema/pro-flash-loop"

const V4_VERIFICATION_REMINDER =
  "\n\n--- V4 VERIFICATION REQUIRED ---\nDeepSeek V4 has a 94% hallucination rate. Inspect touched files and rerun checks before accepting these results."

const DELEGATION_TOOLS = new Set(["task", "call_omo_agent", "call_dsh_agent"])

const FAILURE_SIGNALS = [
  /(^|\s)(fail(ed|ure)?|error|exception|reject(ed)?)(\s|$|:)/i,
  /tests? (fail|failed|failing)/i,
  /exit code [1-9]/i,
  /(cannot|unable to|could not) /i,
  /unhandled/i,
]

const MAX_EVIDENCE_CHARS = 1500

function isV4Model(modelID: string): boolean {
  const lower = modelID.toLowerCase()
  return lower.includes("deepseek-v4") || lower.includes("deepseek_v4")
}

function hasFailureSignal(output: string): boolean {
  if (!output) return false
  const sample = output.slice(0, 20000)
  return FAILURE_SIGNALS.some((pattern) => pattern.test(sample))
}

function hasFailureMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false
  const record = metadata as { stopReason?: unknown; exitCode?: unknown }
  if (record.stopReason === "error" || record.stopReason === "refusal" || record.stopReason === "cancelled") {
    return true
  }
  if (typeof record.exitCode === "number" && record.exitCode !== 0) {
    return true
  }
  return false
}

function buildReplanPrompt(tool: string, evidence: string): string {
  const truncated = evidence.length > MAX_EVIDENCE_CHARS
    ? `${evidence.slice(0, MAX_EVIDENCE_CHARS)}\n... [truncated]`
    : evidence
  return [
    `A delegated ${tool} result failed verification. Re-plan the subtask and re-delegate with the failure evidence below.`,
    `Do not blindly retry the same prompt; adjust the approach or scope, then dispatch again.`,
    "",
    `--- FAILURE EVIDENCE ---`,
    truncated,
    "",
    `--- END FAILURE EVIDENCE ---`,
  ].join("\n")
}

type SessionModelCache = Map<string, string>
type SessionIterationCounts = Map<string, number>

interface EventInput {
  event: {
    type: string
    properties?: unknown
  }
}

interface ToolExecuteAfterInput {
  tool: string
  sessionID: string
  callID: string
}

interface ToolExecuteAfterOutput {
  title?: string
  output?: string
  metadata?: unknown
}

export interface V4VerificationGateDeps {
  readonly ctx: PluginContext
  readonly config: ProFlashLoopConfig
}

export function createV4VerificationGateHook(deps: V4VerificationGateDeps) {
  const { ctx, config } = deps
  const loopEnabled = config.enabled === true
  const maxIterations = config.max_iterations ?? 3
  const evidenceMaxChars = config.evidence_max_chars ?? MAX_EVIDENCE_CHARS
  const sessionModels: SessionModelCache = new Map()
  const sessionIterations: SessionIterationCounts = new Map()

  return {
    event: (input: EventInput): void => {
      if (input.event.type !== "message.updated") return
      const properties = input.event.properties as
        | { info?: { sessionID?: string; modelID?: string; role?: string } }
        | undefined
      const info = properties?.info
      if (!info?.modelID || !info?.sessionID) return
      sessionModels.set(info.sessionID, info.modelID)
    },

    "tool.execute.after": (
      input: ToolExecuteAfterInput,
      output?: ToolExecuteAfterOutput,
    ): void => {
      if (!DELEGATION_TOOLS.has(input.tool)) return
      const modelID = sessionModels.get(input.sessionID)
      if (!modelID || !isV4Model(modelID)) return
      if (!output) return

      output.output = (output.output ?? "") + V4_VERIFICATION_REMINDER
      log("[v4-verification-gate] Appended verification reminder", {
        sessionID: input.sessionID,
        tool: input.tool,
        modelID,
      })

      if (!loopEnabled) return
      const evidence = output.output ?? ""
      if (!hasFailureSignal(evidence) && !hasFailureMetadata(output.metadata)) return

      const iterations = sessionIterations.get(input.sessionID) ?? 0
      if (iterations >= maxIterations) {
        log("[v4-verification-gate] Pro-Flash loop: iteration cap reached, escalating", {
          sessionID: input.sessionID,
          tool: input.tool,
          iterations,
        })
        return
      }
      sessionIterations.set(input.sessionID, iterations + 1)

      const prompt = buildReplanPrompt(input.tool, evidence.slice(0, evidenceMaxChars))
      void dispatchInternalPrompt({
        mode: "async",
        client: ctx.client,
        sessionID: input.sessionID,
        source: "v4-verification-gate",
        queueBehavior: "defer",
        input: {
          path: { id: input.sessionID },
          body: {
            parts: [createInternalAgentContinuationTextPart(prompt)],
          },
          query: { directory: ctx.directory },
        },
      }).then((result) => {
        log("[v4-verification-gate] Pro-Flash loop: re-plan dispatch", {
          sessionID: input.sessionID,
          tool: input.tool,
          status: result.status,
          iteration: iterations + 1,
        })
      }).catch((error: unknown) => {
        log("[v4-verification-gate] Pro-Flash loop: dispatch failed", {
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
  }
}
