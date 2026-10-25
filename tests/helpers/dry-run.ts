import { expect } from "vitest"
import { STAGE_LABEL, type CheckResult, type TestStage } from "../../src/engine/test-mode"
import type { StoreRunContext } from "../../src/stores/module"

export interface Mark {
  stage: TestStage
  result: CheckResult
  detail: string
}

/** Collects the per-step Dry run report the way the task runner does. */
export function recorder() {
  const marks: Mark[] = []
  const logs: { level: string; message: string }[] = []
  const lines: string[] = []
  const part: Pick<StoreRunContext, "mark" | "checklistText" | "log"> = {
    mark: (stage, result, detail) => {
      marks.push({ stage, result, detail })
      lines.push(`${result === "pass" ? "PASS" : result === "fail" ? "FAIL" : "SKIP"} ${STAGE_LABEL[stage]} (0 ms) — ${detail}`)
    },
    checklistText: () => lines.join("\n"),
    log: (level, message) => logs.push({ level, message })
  }
  return { marks, logs, part, cart: () => ({ marks, logs }) }
}

/**
 * The Dry run contract every store must keep:
 * - the steps listed in `stages` are reported and none of them failed,
 * - the final "place" step is reported as simulated,
 * - when the test item went into a real cart and was not removed, the report warns about it.
 */
export function expectDryRunReport(
  rec: ReturnType<typeof recorder>,
  result: { outcome: string; detail?: string },
  input: { stages: TestStage[]; cart: "removed" | "left" | "none" }
): void {
  expect(result.outcome).toBe("tested")
  const seen = rec.marks.map((mark) => mark.stage)
  for (const stage of input.stages) expect(seen, `missing ${stage} in ${seen.join(",")}`).toContain(stage)
  expect(rec.marks.filter((mark) => mark.result === "fail"), JSON.stringify(rec.marks.filter((mark) => mark.result === "fail"))).toEqual([])
  const place = rec.marks.find((mark) => mark.stage === "place")
  expect(place?.result).toBe("skip")
  expect(place?.detail).toMatch(/not sent/i)
  const warned = rec.logs.some((entry) => entry.level === "warn" && /still in your cart/i.test(entry.message))
  if (input.cart === "left") {
    expect(warned, "a leftover test item must be warned about").toBe(true)
    expect(result.detail ?? "").toMatch(/left in the cart/i)
  } else {
    expect(warned, "no leftover warning expected").toBe(false)
  }
}
