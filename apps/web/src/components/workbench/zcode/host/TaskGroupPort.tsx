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
