import { useCallback, useMemo, useRef, useState } from "react";
import type { ProjectTask, ProjectTree } from "@zui/project-sidebar/contract.js";
import { buildTaskEntityKey } from "@zui/lib/taskQueryCache.js";

/** 只保存命令及刷新期间的 UI 意图；不缓存 task，也不建立已接受命令队列。 */
export function useProjectPinIntent(tree: ProjectTree) {
  const inFlight = useRef(new Set<string>());
  const [intents, setIntents] = useState<Record<string, boolean>>({});
  const remove = useCallback((key: string) => {
    inFlight.current.delete(key);
    setIntents((previous) => {
      const { [key]: _done, ...rest } = previous;
      return rest;
    });
  }, []);
  const pin = useCallback(
    async (task: ProjectTask, pinned: boolean, commit: () => Promise<unknown>) => {
      const key = buildTaskEntityKey(task);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setIntents((previous) => ({ ...previous, [key]: pinned }));
      try {
        // commit 包含 Host 命令和权威刷新；完成后释放本次显示意图。
        await commit();
      } finally {
        remove(key);
      }
    },
    [remove],
  );
  const displayed = useMemo(
    () =>
      Object.keys(intents).length
        ? {
            ...tree,
            tasks: tree.tasks.map((task) => {
              const intent = intents[buildTaskEntityKey(task)];
              return intent !== undefined && task.pinned !== intent
                ? { ...task, pinned: intent }
                : task;
            }),
          }
        : tree,
    [tree, intents],
  );
  return { tree: displayed, pin };
}
