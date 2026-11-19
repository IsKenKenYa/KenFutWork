import { createContext, type ReactNode, useContext } from "react";

/**
 * 分组组织读写缝：宿主注入实现，侧栏「分组」页签只消费。
 *
 * 服务端 `task-groups` 的调用需要 code-ui 连接的 `connectionId`，该标识只存在于
 * 宿主客户端内部；侧栏组件拿不到，因此由宿主在装配处注入这三个动作。
 */
export interface TaskGroupPort {
  /** 读取组织结构（revision + 分组 + 成员 + 根层顺序）。 */
  read(): Promise<unknown>;
  /** 新建分组；返回服务端回执。 */
  create(input: { title: string; expectedRevision: number }): Promise<unknown>;
  /** 改名或换色（稀疏字段，未传的保持原值）。 */
  update(input: {
    id: string;
    expectedRevision: number;
    title?: string;
    color?: string;
  }): Promise<unknown>;
  /** 删除分组：成员按原顺序回到根层，不删除任何 Task。 */
  remove(input: { id: string; expectedRevision: number }): Promise<void>;
  /** 移动分组或任务：根层排序与移入移出分组共用。 */
  move(input: {
    node: Record<string, unknown>;
    sourceGroupId: string | null;
    groupId: string | null;
    expectedRevision: number;
    anchor?: { node: Record<string, unknown>; side: "before" | "after" };
  }): Promise<void>;
}

const TaskGroupContext = createContext<TaskGroupPort | null>(null);

export function TaskGroupPortProvider({
  port,
  children,
}: {
  port: TaskGroupPort;
  children: ReactNode;
}) {
  return (
    <TaskGroupContext.Provider value={port}>
      {children}
    </TaskGroupContext.Provider>
  );
}

export function useTaskGroupPort(): TaskGroupPort | null {
  return useContext(TaskGroupContext);
}
