/**
 * Reminder windows in ONE versioned place (F3 handoff §2: "Configurable windows
 * in one versioned config"). Bump the version with any value change so the
 * digest's behaviour stays interpretable over time — the same discipline the
 * reconcile config follows (decision 0010 ruling 6).
 *
 * Two triggers, per the frozen contract:
 *   - due-based: an open/blocked task whose `due` falls within the horizon
 *     (overdue tasks are always inside it, since their due is already past).
 *   - dormant-based: a task whose `dormant` flag is set. The dormancy *window*
 *     itself is NOT redefined here — it is F2's `DORMANT_SILENCE_DAYS` (14),
 *     already reflected in `task.dormant` by the engine's dormancy sync
 *     (decision 0013 ruling 5). We react to the flag; we never recompute it.
 */
export const REMINDER_CONFIG_VERSION = 1;

/** Due within this many hours (or already overdue) ⇒ a due reminder is raised. */
export const REMINDER_DUE_SOON_HORIZON_HOURS = 24;

/**
 * Grace before a past-due task is rendered as "overdue" rather than "due":
 * v1 is zero — the moment `due` passes, the task reads overdue. Kept as a named
 * knob so tuning never happens inline at a call site.
 */
export const REMINDER_OVERDUE_GRACE_HOURS = 0;
