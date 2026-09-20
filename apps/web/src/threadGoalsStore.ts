/**
 * threadGoalsStore — Persistent, client-side store for Thread Goals (/goal).
 *
 * Implements Synara's persistent thread objective model:
 * - Durable goal objective text attached to a thread
 * - Active or paused state
 * - Automatic prompt injection so any coding agent persistently pursues the goal
 * - Full reactivity with listeners and localStorage sync
 *
 * @module threadGoalsStore
 */

export interface ThreadGoalRecord {
  readonly text: string;
  readonly status: "active" | "paused";
  readonly startedAt: number;
}

const STORAGE_KEY = "t3code:thread-goals:v1";

type GoalsMap = Record<string, ThreadGoalRecord>;

let memoryGoals: GoalsMap = {};
const listeners = new Set<() => void>();

function loadGoals(): GoalsMap {
  if (typeof window === "undefined" || !window.localStorage) {
    return memoryGoals;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveGoals(next: GoalsMap): void {
  memoryGoals = next;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage quota errors
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

// Initialize memory state
if (typeof window !== "undefined") {
  memoryGoals = loadGoals();
}

export function getThreadGoal(threadId: string): ThreadGoalRecord | null {
  return memoryGoals[threadId] ?? null;
}

export function setThreadGoal(threadId: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    clearThreadGoal(threadId);
    return;
  }
  const current = memoryGoals[threadId];
  const next: GoalsMap = {
    ...memoryGoals,
    [threadId]: {
      text: trimmed,
      status: current?.status ?? "active",
      startedAt: current?.startedAt ?? Date.now(),
    },
  };
  saveGoals(next);
}

export function pauseThreadGoal(threadId: string): void {
  const current = memoryGoals[threadId];
  if (!current) return;
  const next: GoalsMap = {
    ...memoryGoals,
    [threadId]: {
      ...current,
      status: "paused",
    },
  };
  saveGoals(next);
}

export function resumeThreadGoal(threadId: string): void {
  const current = memoryGoals[threadId];
  if (!current) return;
  const next: GoalsMap = {
    ...memoryGoals,
    [threadId]: {
      ...current,
      status: "active",
    },
  };
  saveGoals(next);
}

export function clearThreadGoal(threadId: string): void {
  if (!memoryGoals[threadId]) return;
  const next = { ...memoryGoals };
  delete next[threadId];
  saveGoals(next);
}

export function subscribeThreadGoals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Format active goal as an untrusted system context block to inject into agent prompt.
 * Modeled after Synara's goal prompt policy.
 */
export function formatGoalPromptHeader(goal: string): string {
  const clean = goal.trim();
  return `[Thread Objective]
The user has established this persistent goal for the thread:
"${clean}"
Keep working toward this full objective and verify your results before claiming completion.`;
}
