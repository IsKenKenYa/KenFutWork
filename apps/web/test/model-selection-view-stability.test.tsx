// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "@zcode/services";
import { describe, expect, it } from "vitest";
import { useModelSelectionServiceView } from "../src/components/workbench/zcode/hooks/useModelSelectionView";

/**
 * 模型选择视图的「同目标沿用」行为（用户口径 2026-11-23：面板抖动）。
 *
 * 提交思考档位会改变 `selection`，进而改变 hook 的 `inputKey`。旧实现在 inputKey
 * 变化的一瞬间把状态退回 loading，composer 的模型菜单里模型分组与档位控件整块变空、
 * 再逐帧长回来——用户看到的是「面板抖动」。
 *
 * 这里锁两件事：
 * 1. 同一服务下只换已选值：读取期间继续返回上一份 ready 视图，不出现 loading；
 * 2. 换服务：立刻回到新服务的状态，不得继续展示旧服务的视图。
 */

function view(revision: number, modelName: string): ModelSelectionView {
  return {
    revision,
    providers: [
      {
        providerId: "p1",
        providerName: "AI Ping",
        models: [{ modelId: modelName, modelName }],
      },
    ],
  } as unknown as ModelSelectionView;
}

/** 每次 getView 都返回一个「稍后解析」的 promise，便于观察读取期间的状态。 */
function deferredService() {
  const pending: Array<{
    resolve: (value: ModelSelectionView) => void;
    reject: (cause: unknown) => void;
  }> = [];
  const service = {
    getView: () =>
      new Promise<ModelSelectionView>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as IModelSelectionService;
  return { service, pending };
}

describe("useModelSelectionServiceView", () => {
  it("同一服务下只改已选值，读取期间继续返回上一份视图", async () => {
    const { service, pending } = deferredService();
    const { result, rerender } = renderHook(
      (props: { selection: string }) =>
        useModelSelectionServiceView(service, true, "remote-waiting", {
          selection: {
            providerId: "p1",
            modelId: "m1",
            options: { reasoningLevel: props.selection },
          },
        } as never),
      { initialProps: { selection: "高" } },
    );

    expect(result.current.state.status).toBe("loading");
    pending[0]?.resolve(view(1, "m1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    // 提交档位：inputKey 变了，但服务没变——不得退回 loading。
    rerender({ selection: "最高" });
    expect(result.current.state.status).toBe("ready");
    if (result.current.state.status === "ready") {
      // 沿用上一份视图的候选目录，界面不会闪空。
      expect(result.current.state.view.providers[0]?.models[0]?.modelId).toBe(
        "m1",
      );
    }

    // 重读完成后换成新视图。
    await waitFor(() => expect(pending.length).toBeGreaterThan(1));
    pending[pending.length - 1]?.resolve(view(2, "m2"));
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
      if (result.current.state.status === "ready") {
        expect(result.current.state.view.revision).toBe(2);
      }
    });
  });

  it("换服务时立刻回到 loading，不继续展示旧服务的视图", async () => {
    const first = deferredService();
    const second = deferredService();
    const { result, rerender } = renderHook(
      (props: { service: IModelSelectionService }) =>
        useModelSelectionServiceView(props.service, true, "remote-waiting", {
          selection: null,
        }),
      { initialProps: { service: first.service } },
    );

    first.pending[0]?.resolve(view(1, "m1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    rerender({ service: second.service });
    expect(result.current.state.status).toBe("loading");
  });

  it("读取失败且还没有视图时依旧暴露错误", async () => {
    const { service, pending } = deferredService();
    const { result } = renderHook(() =>
      useModelSelectionServiceView(service, true, "remote-waiting", {
        selection: null,
      }),
    );

    pending[0]?.reject(new Error("boom"));
    await waitFor(() => expect(result.current.state.status).toBe("error"));
  });
});
