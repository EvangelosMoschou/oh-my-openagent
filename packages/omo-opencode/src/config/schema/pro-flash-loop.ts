import { z } from "zod"

export const ProFlashLoopConfigSchema = z.object({
  /** Enable the Pro-Flash planner-executor loop (default: false) */
  enabled: z.boolean().default(false),
  /** Max re-plan iterations per delegated subtask before escalation (default: 3) */
  max_iterations: z.number().min(1).max(10).default(3),
  /** Truncate the failure evidence injected into the re-plan prompt (chars) */
  evidence_max_chars: z.number().min(256).max(4096).default(1500),
})

export type ProFlashLoopConfig = z.infer<typeof ProFlashLoopConfigSchema>
