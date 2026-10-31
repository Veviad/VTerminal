import type { ProviderActivity } from "./types";

export function activityLabel(activity: ProviderActivity): string {
  const name = activity.kind === "web_search" ? "Web search" : "Web fetch";
  if (activity.status === "running") return activity.kind === "web_search" ? "Searching web…" : "Fetching web page…";
  return `${name} · ${activity.status === "done" ? "Completed" : activity.status === "error" ? "Failed" : activity.status === "cancelled" ? "Cancelled" : "Interrupted"}`;
}

/** No terminal result means unknown completion, even when the response ended. */
export function settleActivities(
  activities: ProviderActivity[],
  status: "error" | "cancelled" | "interrupted" = "interrupted",
): ProviderActivity[] {
  return activities.map((activity) => activity.status === "running" ? { ...activity, status } : activity);
}

export function updateActivity(activities: ProviderActivity[], activity: ProviderActivity): ProviderActivity[] {
  return activities.some((item) => item.id === activity.id)
    ? activities.map((item) => item.id === activity.id ? activity : item)
    : [...activities, activity];
}
