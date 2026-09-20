import { useEffect, useState } from "react";
import {
  clearThreadGoal,
  getThreadGoal,
  pauseThreadGoal,
  resumeThreadGoal,
  setThreadGoal,
  subscribeThreadGoals,
  type ThreadGoalRecord,
} from "../threadGoalsStore";

export function useThreadGoal(threadId: string | null | undefined): {
  readonly goal: ThreadGoalRecord | null;
  readonly setGoal: (text: string) => void;
  readonly pauseGoal: () => void;
  readonly resumeGoal: () => void;
  readonly clearGoal: () => void;
} {
  const [goal, setGoalRecord] = useState<ThreadGoalRecord | null>(() =>
    threadId ? getThreadGoal(threadId) : null,
  );

  useEffect(() => {
    if (!threadId) {
      setGoalRecord(null);
      return;
    }
    setGoalRecord(getThreadGoal(threadId));
    return subscribeThreadGoals(() => {
      setGoalRecord(getThreadGoal(threadId));
    });
  }, [threadId]);

  return {
    goal,
    setGoal: (text: string) => {
      if (threadId) setThreadGoal(threadId, text);
    },
    pauseGoal: () => {
      if (threadId) pauseThreadGoal(threadId);
    },
    resumeGoal: () => {
      if (threadId) resumeThreadGoal(threadId);
    },
    clearGoal: () => {
      if (threadId) clearThreadGoal(threadId);
    },
  };
}
