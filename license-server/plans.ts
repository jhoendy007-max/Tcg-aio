/** Pure data, safe to import from the desktop renderer. */
/** Every feature a license can carry. Add a new id here, then add it to the plans that include it. */
export const FEATURES = ["aco"] as const
export type FeatureId = (typeof FEATURES)[number]

/** Plans are presets of features. More plans can be added later without changing the grant format. */
export const PLANS: Record<string, { label: string; features: FeatureId[] }> = {
  standard: { label: "Standard (no ACO)", features: [] },
  aco: { label: "ACO", features: ["aco"] }
}
export const PLAN_IDS = Object.keys(PLANS)

export function isPlanId(plan: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLANS, plan)
}

export function featuresForPlan(plan: string): FeatureId[] {
  if (plan === "owner") return [...FEATURES]
  return [...(PLANS[plan]?.features ?? [])]
}

