import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import type { IBroadcastService, ITaskGroupService } from "@zcode/services";
import type {
  GroupTaskRef,
  MoveGroupNode,
  ProjectTree,
  TaskGroup,
  TaskGroupStructure,
} from "@zui/project-sidebar/contract.js";
import { groupTaskRef } from "@zui/project-sidebar/grouped-view.js";
import { logger } from "@zui/logger.js";
const EMPTY: TaskGroupStructure = { revision: 0, groups: [], members: [], order: [] };
type SaveGroupInput = Parameters<ITaskGroupService["save"]>[0];
type CreationInput = Extract<SaveGroupInput, { creationId: string }>;
type Lifetime = { active: boolean };
export interface GroupRenameDraft {
  groupId: string;
  editId: string;
  expectedRevision: number;
  originalTitle: string;
  title: string;
  version: number;
  pending: boolean;
  error: string | null;
}

function useGroupCreation(
  save: (input: SaveGroupInput) => Promise<TaskGroup>,
  lifetime: Lifetime,
) {
  const [creation, setCreation] = useState<{
    intent: CreationInput;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const current = useRef(creation);
  const flight = useRef<Promise<TaskGroup> | null>(null);
  const publish = useCallback((value: typeof creation) => {
    current.current = value;
    setCreation(value);
  }, []);
  useEffect(() => {
    if (lifetime.active) {
      flight.current = null;
      publish(null);
    }
  }, [lifetime, publish]);
  const createGroup = useCallback((title: string, expectedRevision: number) => {
    if (flight.current) return flight.current;
    const intent = current.current?.intent ?? {
      creationId: crypto.randomUUID(), expectedRevision, title,
    };
    const pending = { intent, pending: true, error: null };
    publish(pending);
    const request = save(intent).then((group) => {
      if (lifetime.active && current.current === pending) publish(null);
      return group;
    }, (cause: unknown) => {
      if (lifetime.active && current.current === pending) {
        // 确定未接纳的旧意图结束；下一次明确新建才生成新身份和观察值。
        // 响应未知时仍保留同一意图，手动重试不能重复创建。
        const conflict = cause instanceof Error && "code" in cause &&
          cause.code === "task_group_revision_conflict";
        publish(conflict ? null : { intent, pending: false, error: String(cause) });
      }
      throw cause;
    }).finally(() => {
      if (flight.current === request) flight.current = null;
    });
    flight.current = request;
    return request;
  }, [save, lifetime, publish]);
  return useMemo(() => ({ creation, createGroup }), [creation, createGroup]);
}

function useGroupRenames(
  save: (input: SaveGroupInput) => Promise<TaskGroup>,
  lifetime: Lifetime,
) {
  const [renameDrafts, setRenameDrafts] = useState<Record<string, GroupRenameDraft>>({});
  const current = useRef(renameDrafts);
  const flights = useRef(new Map<string, Promise<void>>());
  const update = useCallback((id: string, change: (draft: GroupRenameDraft | undefined) => GroupRenameDraft | undefined) => {
    const next = { ...current.current };
    const draft = change(next[id]);
    if (draft) next[id] = draft;
    else delete next[id];
    current.current = next;
    setRenameDrafts(next);
  }, []);
  useEffect(() => {
    if (lifetime.active) {
      current.current = {};
      flights.current.clear();
      setRenameDrafts({});
    }
  }, [lifetime]);
  const beginRename = useCallback((group: TaskGroup, expectedRevision: number) => {
    update(group.id, (previous) => ({
      groupId: group.id, editId: crypto.randomUUID(), expectedRevision,
      originalTitle: group.title, title: previous?.title ?? group.title,
      version: 0, pending: false, error: null,
    }));
  }, [update]);
  const changeRename = useCallback((id: string, title: string) => {
    update(id, (draft) => draft ? { ...draft, title, version: draft.version + 1 } : draft);
  }, [update]);
  const cancelRename = useCallback((id: string) => update(id, () => undefined), [update]);
  const commitRename = useCallback((id: string): Promise<void> => {
    const draft = current.current[id];
    if (!draft) return Promise.resolve();
    const key = `${id}:${draft.editId}`;
    const existing = flights.current.get(key);
    if (existing) return existing;
    const title = draft.title.trim() || draft.originalTitle;
    if (title === draft.originalTitle) {
      cancelRename(id);
      return Promise.resolve();
    }
    update(id, (value) => value ? { ...value, pending: true, error: null } : value);
    const request = save({ id, title, expectedRevision: draft.expectedRevision }).then((saved) => {
      if (!lifetime.active) return;
      update(id, (value) => {
        if (value?.editId !== draft.editId) return value;
        return value.version === draft.version ? undefined : {
          ...value,
          pending: false,
          originalTitle: saved.title,
          // 已确认的改名只推进一次组织修订；后续输入等待用户再次明确保存。
          expectedRevision: draft.expectedRevision + 1,
        };
      });
    }, (cause: unknown) => {
      if (lifetime.active)
        update(id, (value) => value?.editId === draft.editId ? { ...value, pending: false, error: String(cause) } : value);
      throw cause;
    }).finally(() => {
      if (flights.current.get(key) === request) flights.current.delete(key);
    });
    flights.current.set(key, request);
    return request;
  }, [save, lifetime, update, cancelRename]);
  return useMemo(() => ({ renameDrafts, beginRename, changeRename, cancelRename, commitRename }),
    [renameDrafts, beginRename, changeRename, cancelRename, commitRename]);
}

function useTaskGroupReadState(service: ITaskGroupService | undefined, broadcast: IBroadcastService) {
  const [structure, setStructure] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [readySignature, setReadySignature] = useState<string | null>(null);
  const registration = useRef<{ signature: string; done: boolean } | null>(null);
  const lifetime = useMemo(() => ({ active: true, service }), [service]);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!service) {
      setStructure(EMPTY);
      return;
    }
    try {
      const next = await service.read();
      if (request === serial.current) {
        setStructure(next);
        setError(null);
        if (registration.current?.done)
          setReadySignature(registration.current.signature);
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        logger.error("[task-groups] 读取分组失败", cause);
      }
      throw cause;
    }
  }, [service]);
  useEffect(() => {
    lifetime.active = true;
    const subscription = broadcast.onMessage((event) => {
      if (event.channel === "state:task-groups")
        void refresh().catch((cause) => logger.error("[task-groups] 广播刷新失败", cause));
    });
    return () => {
      serial.current++;
      lifetime.active = false;
      subscription.dispose();
    };
  }, [broadcast, refresh, lifetime]);
  return { structure, error, setError, readySignature, setReadySignature, registration, lifetime, refresh };
}

function useTaskGroupRegistration(
  tree: ProjectTree,
  directoryLoading: boolean,
  service: ITaskGroupService | undefined,
  state: ReturnType<typeof useTaskGroupReadState>,
) {
  const { setReadySignature, registration, refresh, setError } = state;
  // 活动时间/stream 不触发登记；仅首次身份、系统标记和明确删除有组织语义。
  const signature = useMemo(() => {
    // 原来每次活动渲染都排序并在比较器中反复序列化；只在事实输入变化时计算一次键。
    const entries = [
      ...tree.tasks
        .filter((task) => task.hostId === "local" && task.workspacePath && task.workspaceIdentity)
        .map((task) => [groupTaskRef(task)]),
    ].map((entry) => JSON.stringify(entry));
    entries.sort((a, b) => a.localeCompare(b));
    return `[${entries.join(",")}]`;
  }, [tree.tasks]);
  const deletedSignature = JSON.stringify(tree.deletedTasks ?? []);
  useEffect(() => {
    setReadySignature(null);
    registration.current = { signature, done: false };
    if (!service || directoryLoading) return;
    const entries = JSON.parse(signature) as Array<[GroupTaskRef]>;
    let active = true;
    void (async () => {
      const tasks = entries.map(([task]) => task);
      if (tasks.length) await service.admit({ tasks });
      if (!active) return;
      registration.current = { signature, done: true };
      await refresh();
    })().catch((cause: unknown) => {
      if (active) setError(String(cause));
      logger.error("[task-groups] 任务登记未完成，保留原结构", cause);
    });
    return () => {
      active = false;
    };
  }, [service, signature, deletedSignature, directoryLoading, refresh, registration, setReadySignature, setError]);
  return signature;
}

/** 控制端唯一订阅；三个筛选视图和所有任务菜单共享同一份已接受结构。 */
export function useTaskGroups(tree: ProjectTree, directoryLoading = false) {
  const services = useBaseWorkspaceServices();
  const service = services.taskGroupService;
  const state = useTaskGroupReadState(service, services.broadcastService);
  const signature = useTaskGroupRegistration(tree, directoryLoading, service, state);
  const { structure, error, readySignature, lifetime, refresh } = state;
  const required = useCallback(() => {
    if (!service) throw new Error("task-group.service-unavailable");
    return service;
  }, [service]);
  const refreshAfterMutation = useCallback(() => {
    // 写入回执已确认；后续读取失败由目录错误状态表达，不能撤销已确认的编辑基线。
    void refresh().catch((cause: unknown) =>
      logger.error("[task-groups] 变更已确认，组织读取失败", cause),
    );
  }, [refresh]);
  const save = useCallback(
    async (input: SaveGroupInput) => {
      const result = await required().save(input);
      refreshAfterMutation();
      return result;
    },
    [required, refreshAfterMutation],
  );
  const move = useCallback(
    async (input: MoveGroupNode, expectedRevision: number) => {
      await required().move({ ...input, expectedRevision });
      refreshAfterMutation();
    },
    [required, refreshAfterMutation],
  );
  const ungroup = useCallback(
    async (input: { id: string; expectedRevision: number }) => {
      await required().ungroup(input);
      refreshAfterMutation();
    },
    [required, refreshAfterMutation],
  );
  const creation = useGroupCreation(save, lifetime);
  const renames = useGroupRenames(save, lifetime);
  const parents = useMemo(
    () =>
      new Map(
        structure.members.map((member) => [
          JSON.stringify([member.workspaceKey, member.taskId]),
          member.groupId,
        ]),
      ),
    [structure],
  );
  return useMemo(
    () => ({
      structure,
      parents,
      error,
      refresh,
      save,
      move,
      ungroup,
      ...creation,
      ...renames,
      available: Boolean(service) && !directoryLoading && readySignature === signature,
    }),
    [structure, parents, error, refresh, save, move, ungroup, service, creation, renames, directoryLoading, readySignature, signature],
  );
}
