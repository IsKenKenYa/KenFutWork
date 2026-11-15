"use client";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  type BackgroundJob,
  getMediaJobErrorMessage,
} from "@kenfutwork/shared";
import { useEffect, useRef, useState } from "react";
import { cancelBackgroundJob, fetchGenerationRequest } from "../lib/server-api";

const TERMINAL = new Set(["succeeded", "failed", "dead_letter", "canceled"]);

type GenerationIssue = "read" | "sync";
type GenerationRequest = { id: string; requestId: string };

function cancellationState(job: BackgroundJob): string | undefined {
  const value = job.payload._generation_cancel;
  return value &&
    typeof value === "object" &&
    "state" in value &&
    typeof value.state === "string"
    ? value.state
    : undefined;
}

function cancellationMessage(jobs: BackgroundJob[]): string | undefined {
  const states = jobs.map(cancellationState);
  if (states.includes("unknown")) return "取消结果待确认，请到供应商确认。";
  if (states.includes("pending")) return "停止中";
  if (states.includes("local_only")) return "已本地停止";
  if (states.includes("requested")) return "已请求云端取消";
  return undefined;
}

function outputAssets(jobs: BackgroundJob[]): Set<string> {
  const assets = new Set<string>();
  for (const job of jobs) {
    if (!job.result) continue;
    const outputs = Array.isArray(job.result.outputs) ? job.result.outputs : [];
    for (const output of [job.result, ...outputs]) {
      if (
        output &&
        typeof output === "object" &&
        "asset_id" in output &&
        typeof output.asset_id === "string" &&
        output.asset_id
      ) {
        assets.add(output.asset_id);
      }
    }
  }
  return assets;
}

function requestedCount(jobs: BackgroundJob[], fallback: unknown): number {
  const declared = jobs
    .map((job) => job.payload.requested_count)
    .find(
      (count) =>
        typeof count === "number" && Number.isInteger(count) && count > 0,
    );
  if (typeof declared === "number") return declared;
  return typeof fallback === "number" &&
    Number.isInteger(fallback) &&
    fallback > 0
    ? fallback
    : 1;
}

/** 场景只保存请求引用；状态和成果始终由服务端Job提供。关闭浮层不停止跟踪。 */
export function useCanvasGenerationJobs(options: {
  api: ExcalidrawImperativeAPI | null;
  canvasId: string;
  projectId: string;
  accessToken: string | null;
  refresh: () => Promise<void>;
}) {
  const current = useRef(options);
  current.current = options;
  const { api, canvasId, projectId } = options;
  const [notice, setNotice] = useState<{
    api: ExcalidrawImperativeAPI;
    issue: GenerationIssue;
  } | null>(null);
  useEffect(() => {
    if (!api) return;
    const scene = api;
    const completed = new Set<string>();
    const canceled = new Set<string>();
    const refreshed = new Map<string, Set<string>>();
    const issues = new Map<string, GenerationIssue>();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visibleIssue: GenerationIssue | undefined;
    setNotice((previous) => (previous?.api === scene ? null : previous));

    function activeRequests(): GenerationRequest[] {
      return scene.getSceneElements().flatMap((element) => {
        const data = element.customData;
        return !element.isDeleted &&
          data?.status === "generating" &&
          typeof data.requestId === "string" &&
          !completed.has(data.requestId)
          ? [{ id: element.id, requestId: data.requestId }]
          : [];
      });
    }

    function publishIssues() {
      if (controller.signal.aborted) return;
      if (issues.size === 0 && visibleIssue === undefined) return;
      const active = new Set(
        activeRequests().map(({ requestId }) => requestId),
      );
      for (const requestId of issues.keys())
        if (!active.has(requestId)) issues.delete(requestId);
      const kinds = [...issues.values()];
      const issue = kinds.includes("read") ? "read" : kinds[0];
      if (issue === visibleIssue) return;
      visibleIssue = issue;
      setNotice(issue ? { api: scene, issue } : null);
    }
    function patch(
      id: string,
      requestId: string,
      data: Record<string, unknown>,
      deleted = false,
    ) {
      if (controller.signal.aborted) return;
      api?.updateScene({
        elements: api.getSceneElementsIncludingDeleted().map((element) =>
          element.id === id &&
          !element.isDeleted &&
          element.customData?.requestId === requestId
            ? {
                ...element,
                customData: { ...element.customData, ...data },
                isDeleted: deleted,
                version: element.version + 1,
                versionNonce: Math.floor(Math.random() * 2_000_000_000),
                updated: Date.now(),
              }
            : element,
        ),
        captureUpdate: "IMMEDIATELY",
      });
    }
    async function project(
      id: string,
      requestId: string,
      jobs: BackgroundJob[],
    ) {
      if (!jobs.length || controller.signal.aborted) return;
      if (
        jobs.some(
          (job) =>
            job.canvas_id !== canvasId ||
            job.project_id !== projectId ||
            job.payload.generator_id !== id,
        )
      ) {
        completed.add(requestId);
        patch(id, requestId, {
          status: "error",
          errorMessage: "任务不属于当前画布，请重新生成。",
        });
        return;
      }
      const jobIds = jobs.map((job) => job.id);
      const generator = api
        ?.getSceneElements()
        .find(
          (element) =>
            element.id === id && element.customData?.requestId === requestId,
        );
      const assets = outputAssets(jobs);
      const actual = assets.size;
      const expected = requestedCount(jobs, generator?.customData?.count);
      const unit =
        generator?.customData?.type === "video-generator" ? "段" : "张";
      const previousAssets = refreshed.get(requestId) ?? new Set<string>();
      if ([...assets].some((asset) => !previousAssets.has(asset))) {
        await current.current.refresh();
        refreshed.set(requestId, new Set([...previousAssets, ...assets]));
      }
      if (
        !jobs.every(
          (job) =>
            TERMINAL.has(job.status) && cancellationState(job) !== "pending",
        )
      ) {
        const element = api
          ?.getSceneElements()
          .find((entry) => entry.id === id);
        if (
          JSON.stringify(element?.customData?.jobIds) !== JSON.stringify(jobIds)
        )
          patch(id, requestId, { jobIds });
        const cancellation = cancellationMessage(jobs);
        const message =
          actual > 0
            ? `已生成${actual}/${expected}${unit}${cancellation ? ` · ${cancellation}` : ""}`
            : cancellation;
        if (message && element?.customData?.errorMessage !== message)
          patch(id, requestId, { errorMessage: message });
        return;
      }
      if (
        jobs.every((job) => job.status === "succeeded") &&
        actual >= expected
      ) {
        patch(id, requestId, { jobIds, status: "completed" }, true);
      } else {
        const failure = jobs.find(
          (job) =>
            job.status !== "succeeded" && (job.error_code || job.error_message),
        );
        const reason =
          cancellationMessage(jobs) ??
          getMediaJobErrorMessage(failure?.error_code) ??
          failure?.error_message ??
          (actual < expected ? "返回数量不足。" : "生成已停止，请重新生成。");
        patch(id, requestId, {
          jobIds,
          status: "error",
          errorMessage: `已生成${actual}/${expected}${unit} · ${reason}`,
        });
      }
      completed.add(requestId);
    }
    async function requestCancellation(
      job: BackgroundJob,
      request: GenerationRequest,
    ) {
      if (TERMINAL.has(job.status) || canceled.has(job.id)) return job;
      try {
        const result = await cancelBackgroundJob(
          current.current.accessToken,
          job.id,
        );
        canceled.add(job.id);
        return result;
      } catch {
        patch(request.id, request.requestId, {
          errorMessage: "停止请求待确认",
        });
        return job;
      }
    }

    async function refreshRequest(request: GenerationRequest) {
      const { id, requestId } = request;
      let jobs: BackgroundJob[];
      try {
        const response = await fetchGenerationRequest(
          current.current.accessToken,
          requestId,
          controller.signal,
        );
        jobs = response.jobs;
      } catch {
        issues.set(requestId, "read");
        publishIssues();
        return;
      }
      if (controller.signal.aborted) return;
      const generator = scene
        .getSceneElements()
        .find(
          (element) =>
            element.id === id &&
            !element.isDeleted &&
            element.customData?.requestId === requestId &&
            element.customData?.status === "generating",
        );
      if (!generator) {
        publishIssues();
        return;
      }
      try {
        if (
          generator.customData?.cancelRequested === true &&
          jobs.every(
            (job) =>
              job.canvas_id === canvasId &&
              job.project_id === projectId &&
              job.payload.generator_id === id,
          )
        ) {
          jobs = await Promise.all(
            jobs.map((job) => requestCancellation(job, request)),
          );
        }
        await project(id, requestId, jobs);
        issues.delete(requestId);
      } catch {
        issues.set(requestId, "sync");
      }
      publishIssues();
    }

    async function scan() {
      try {
        publishIssues();
        await Promise.all(activeRequests().map(refreshRequest));
      } finally {
        if (!controller.signal.aborted)
          // 仅刷新本地画布状态，不限制后台生成/请求数量；固定UI刷新节奏。
          timer = setTimeout(() => {
            void scan();
          }, 2000);
      }
    }
    void scan();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, canvasId, projectId]);
  return notice?.api === api ? notice.issue : null;
}
