import { FEATURES, featuresForPlan, PLANS, type FeatureId } from "../../license-server/plans"

export { FEATURES, featuresForPlan, PLANS, type FeatureId }

const OWNER_EMAIL = "jhoendy007@gmail.com"

/**
 * Features this PC may use, read from the signed grant. The owner gets every feature.
 * A grant signed before plans existed has no list; those licenses were migrated to ACO,
 * so it keeps ACO until the next check-in replaces it with a signed list.
 */
export function grantFeatures(input: { role?: string; email?: string; features?: readonly string[] | null }): FeatureId[] {
  if (input.role === "owner" || input.email?.trim().toLowerCase() === OWNER_EMAIL) return [...FEATURES]
  if (Array.isArray(input.features)) return FEATURES.filter((id) => input.features!.includes(id))
  return ["aco"]
}

export function hasFeature(input: { role?: string; email?: string; features?: readonly string[] | null }, feature: FeatureId): boolean {
  return grantFeatures(input).includes(feature)
}
