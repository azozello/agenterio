"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskDto, UpdateTaskRequest } from "@agentslack/shared";
import { api, errorMessage } from "./api";
import { getSocket } from "./socket";
import { applyTaskChange, upsertTask } from "./tasks";

/** Calls `handler` for every `task.changed` the socket receives. */
export function useTaskChanged(handler: (task: TaskDto) => void) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const socket = getSocket();
    const onChanged = (task: TaskDto) => ref.current(task);
    socket.on("task.changed", onChanged);
    return () => {
      socket.off("task.changed", onChanged);
    };
  }, []);
}

/** All tasks of a project (features, tasks and bugs) in backlog order, kept live. */
export function useProjectTasks(projectId: string) {
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks(await api.tasks(projectId));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    setTasks(null);
    void load();
    // Catch up on changes missed while the socket was down.
    const socket = getSocket();
    const onConnect = () => void load();
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect", onConnect);
    };
  }, [load]);

  useTaskChanged((task) => {
    if (task.projectId === projectId) setTasks((cur) => (cur ? applyTaskChange(cur, task) : cur));
  });

  /**
   * Applies `optimistic` locally, sends `input`, and rolls back if the API refuses.
   * Resolves to the error message, or null on success.
   */
  const update = useCallback(async (task: TaskDto, input: UpdateTaskRequest, optimistic: Partial<TaskDto>) => {
    setTasks((cur) => (cur ? upsertTask(cur, { ...task, ...optimistic }) : cur));
    try {
      const saved = await api.updateTask(task.id, input);
      setTasks((cur) => (cur ? applyTaskChange(cur, saved) : cur));
      return null;
    } catch (err) {
      setTasks((cur) => (cur ? upsertTask(cur, task) : cur));
      return errorMessage(err);
    }
  }, []);

  const add = useCallback((task: TaskDto) => setTasks((cur) => (cur ? applyTaskChange(cur, task) : [task])), []);

  return { tasks, loadError, reload: load, update, add };
}
