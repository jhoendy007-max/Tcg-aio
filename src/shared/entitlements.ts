export const FEATURES = ["aco"] as const
export type FeatureId = (typeof FEATURES)[number]

export const PLAN_FEATURES: Record<"standard" | "aco", FeatureId[]> = {
  standard: [],
  aco: ["aco"]
}

const OWNER_EMAIL = "jhoendy007@gmail.com"

/** Signed feature list. Owner gets every feature. A grant with no list keeps ACO until the next heartbeat. */
export function grantFeatures(input: { role?: string; email?: string; features?: readonly string[] | null }): FeatureId[] {
  if (input.role === "owner" || input.email?.trim().toLowerCase() === OWNER_EMAIL) return [...FEATURES]
  if (Array.isArray(input.features)) return FEATURES.filter((id) => input.features!.includes(id))
  return ["aco"]
}

export function featuresForPlan(plan: string): FeatureId[] {
  if (plan === "owner") return [...FEATURES]
  if (plan === "aco") return [...PLAN_FEATURES.aco]
  return [...PLAN_FEATURES.standard]
}
