"use client";

import type {
  ManagementTarget,
  WorkbenchMode,
  WorkbenchModes,
} from "@kenfutwork/shared";
import { installDesktopTitlebarDrag } from "@zcode/ui/design-shared";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useFlowHostEntry } from "@/hooks/use-flow-host";
import { useWorkHostEntry } from "@/hooks/use-work-host";
import { addModelSettingsOpenListener } from "@/lib/model-settings-navigation";
import { CodeWorkbenchFrame } from "./code-workbench-frame";
import { ManagementDocumentFrame } from "./management-document-frame";

/**
 * 工作台（融合后唯一形态）：恒渲染 Code 壳（zcode UI），Design / Flow 是壳内的
 * 主区视图——模式不再换壳，深链 `?mode=` 解析后经 workbench-navigation 推给壳。
 * 原画布工作台壳（白底标题栏 + 顶部模式页签）已退役。
 */
function WorkbenchModeSurface() {
  useEffect(() => installDesktopTitlebarDrag(document), []);
  const search = useSearchParams();
  // 深链意图只在挂载时取一次：随后 URL 参数会被清掉（见 Workbench），不能让
  // 「参数消失」把已进入的 design/flow 又弹回 code——壳内切模式才是后续的真相源。
  const [requested] = useState(() => search.get("mode"));
  const [requestedCanvas] = useState(() => search.get("canvasId"));
  const { entry: flowEntry } = useFlowHostEntry();
  const { entry: workEntry } = useWorkHostEntry();
  // 模式探针未落定（entry=null）时先只给 code/design 兜底，落定后按可用性扩展——
  // flow 与 work 各自独立门控（入口纪律：插件未装 / 适配层未通不出现对应入口）。
  const availableModes = useMemo<WorkbenchModes>(() => {
    const modes: WorkbenchModes = ["code", "design"];
    if (flowEntry?.available) modes.push("flow");
    if (workEntry?.available) modes.push("work");
    return modes;
  }, [flowEntry?.available, workEntry?.available]);
  // 深链解析：探针未落定前不推对应模式（落定后可用才推，不可用回落——
  // 与旧壳「flow 不可用时弹回 Design」同一条纪律；work 不可用回落 code）。
  const mode = useMemo<WorkbenchMode | undefined>(() => {
    if (requested === "design") return "design";
    if (requested === "flow")
      return flowEntry === null
        ? "code"
        : flowEntry.available
          ? "flow"
          : "design";
    if (requested === "work")
      return workEntry === null
        ? "code"
        : workEntry.available
          ? "work"
          : "code";
    return requested === "code" ? "code" : undefined;
  }, [requested, flowEntry, workEntry]);
  // 管理文档 keep-alive：首次打开后持续挂载（hidden 收起），重复打开不重载。
  const [management, setManagement] = useState<ManagementTarget | null>(null);
  const openManagement = useCallback((target: ManagementTarget) => {
    setManagement(target);
  }, []);
  useEffect(
    () =>
      addModelSettingsOpenListener(() =>
        openManagement({ page: "settings", section: "modelProvider" }),
      ),
    [openManagement],
  );
  const closeManagement = useCallback(() => setManagement(null), []);

  return (
    <>
      <CodeWorkbenchFrame
        availableModes={availableModes}
        {...(mode ? { mode } : {})}
        {...(requestedCanvas ? { canvasId: requestedCanvas } : {})}
        onOpenManagement={openManagement}
      />
      {/* 管理文档**预加载**：页面挂载即后台建好 iframe（hidden），点设置/插件市场
          零加载（用户口径：不想看到加载）。目标变化经 management-target 推送，
          文档内切换不重载。 */}
      <ManagementDocumentFrame
        target={management ?? { page: "settings" }}
        visible={management !== null}
        onClose={closeManagement}
      />
    </>
  );
}

/** 管理文档持续挂载；模式切换只发生在壳内，不卸载工作台。 */
export function Workbench() {
  // 一次性消费深链参数：壳已按初始模式启动，URL 上的 ?mode= 不再参与后续渲染，
  // 避免刷新/分享时旧参数压着壳内已切换的模式。
  const search = useSearchParams();
  const router = useRouter();
  const [stripped] = useState(() => !search.get("mode"));
  useEffect(() => {
    if (!stripped) router.replace("/workbench");
  }, [stripped, router]);
  return (
    <Suspense>
      <WorkbenchModeSurface />
    </Suspense>
  );
}
