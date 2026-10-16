export type SchedulePhase = "waiting" | "warming" | "started" | "stopped"
export type ScheduleAction = "idle" | "wait" | "warm" | "start" | "stop" | "missed"

export interface ScheduleClock {
  enabled: boolean
  startAt: number
  stopAt: number | null
  warmupMin: number
  phase: SchedulePhase
}

export function scheduleAction(schedule: ScheduleClock, now: number): ScheduleAction {
  if (!schedule.enabled || schedule.phase === "stopped") return "idle"
  if (schedule.stopAt && now >= schedule.stopAt) return schedule.phase === "started" ? "stop" : "missed"
  if (schedule.phase === "started") return "idle"
  if (now >= schedule.startAt) return "start"
  const lead = Math.max(0, schedule.warmupMin) * 60_000
  if (schedule.phase === "waiting" && lead > 0 && now >= schedule.startAt - lead) return "warm"
  return "wait"
}

export interface DropTaskRef {
  id: string
  accountId: string
  group?: string
}

export interface DropPlan {
  id: string
  name: string
  action: "warm" | "start" | "stop" | "missed"
  taskIds: string[]
  accountIds: string[]
}

export function tasksForSchedule<T extends DropTaskRef>(schedule: { taskIds: string[]; group: string }, tasks: T[]): T[] {
  const ids = new Set(schedule.taskIds)
  const group = schedule.group.trim().toLowerCase()
  return tasks.filter((task) => ids.has(task.id) || (group !== "" && (task.group ?? "").trim().toLowerCase() === group))
}

export function planDrops<T extends DropTaskRef>(
  schedules: Array<ScheduleClock & { id: string; name: string; taskIds: string[]; group: string }>,
  tasks: T[],
  now: number
): DropPlan[] {
  const plans: DropPlan[] = []
  for (const schedule of schedules) {
    const action = scheduleAction(schedule, now)
    if (action !== "warm" && action !== "start" && action !== "stop" && action !== "missed") continue
    const matched = tasksForSchedule(schedule, tasks)
    plans.push({
      id: schedule.id,
      name: schedule.name,
      action,
      taskIds: matched.map((task) => task.id),
      accountIds: [...new Set(matched.map((task) => task.accountId))]
    })
  }
  return plans
}
