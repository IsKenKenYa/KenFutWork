"use client";

import type { TaskToolEntry } from "@/lib/workbench-tools";

import { ToolOutputRenderer } from "../chat/tool-block-view";
import { formatParamName, formatParamValue } from "../chat/utils";

/**
 * 工具调用行的共享部件：状态语义（颜色/文案）与展开后的「入参 + 输出」详情。
 *
 * 对话流里的工具行（workbench.tsx）与轨迹视图的账本工具行（trajectory-view.tsx）
 * 是同一份数据的两个投影，展开体必须一致——抽在这里，别让第二份实现长出来。
 */

export type ToolStatusMeta = {
  /** 行内状态文案（执行中… / 已完成 / 失败 / 被拒绝）。 */
  text: string;
  /** 状态点的颜色类。 */
  dotClass: string;
  /** 文案是否按失败着色（失败原因要红着显示，不能混在普通灰字里）。 */
  failed: boolean;
};

export function toolStatusMeta(tool: TaskToolEntry): ToolStatusMeta {
  const failed =
    tool.summary?.startsWith("失败") === true ||
    (tool.output?.error as string | undefined) !== undefined;
  if (tool.status === "running") {
    return {
      text: "执行中…",
      dotClass: "animate-pulse bg-amber-500",
      failed: false,
    };
  }
  if (tool.status === "denied") {
    return { text: "被拒绝", dotClass: "bg-rose-500", failed: false };
  }
  if (failed) {
    return { text: "失败", dotClass: "bg-red-500", failed: true };
  }
  return { text: "已完成", dotClass: "bg-emerald-500", failed: false };
}

/** 产物预览（图/视频，tool.completed 带回）：此前事件里带了这个字段但被丢弃。 */
function ToolArtifactsPreview({ tool }: { tool: TaskToolEntry }) {
  if (!tool.artifacts || tool.artifacts.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        产物
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {tool.artifacts.map((artifact) =>
          artifact.type === "image" ? (
            // biome-ignore lint/performance/noImgElement: 产物是任意远端地址（用户自己的存储/画布产物），next/image 的域名白名单与优化不适用于工作台流
            <img
              key={artifact.url}
              src={artifact.url}
              alt={artifact.title ?? "生成的图片"}
              className="max-h-44 rounded-lg border border-border/60"
            />
          ) : (
            <video
              key={artifact.url}
              src={artifact.url}
              controls
              className="max-h-44 rounded-lg border border-border/60"
            >
              {/* AI 生成的视频产物没有可挂的字幕文件；空 track 满足媒体可达性口径 */}
              <track kind="captions" />
            </video>
          ),
        )}
      </div>
    </div>
  );
}

/** 展开体：入参（逐字段）+ 输出（专用渲染器 / 结论文字）+ 产物预览。没有可展开内容时调用方禁用展开。 */
export function ToolEventDetail({ tool }: { tool: TaskToolEntry }) {
  return (
    <div className="mt-2 space-y-2 border-l-2 border-border/60 pl-3">
      {tool.input && Object.keys(tool.input).length > 0 ? (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            入参
          </div>
          <div className="mt-1 space-y-1">
            {Object.entries(tool.input).map(([key, value]) => (
              <div key={key} className="rounded-md bg-muted px-2 py-1.5">
                <div className="text-[10px] text-muted-foreground">
                  {formatParamName(key)}
                </div>
                <div className="break-all whitespace-pre-wrap text-[11px]">
                  {formatParamValue(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {tool.output ? (
        <ToolOutputRenderer toolName={tool.toolName} output={tool.output} />
      ) : tool.summary ? (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            输出
          </div>
          <div
            className={`mt-1 whitespace-pre-wrap break-words text-[11px] ${
              toolStatusMeta(tool).failed
                ? "text-red-600 dark:text-red-400"
                : "text-foreground/90"
            }`}
          >
            {tool.summary}
          </div>
        </div>
      ) : null}
      <ToolArtifactsPreview tool={tool} />
    </div>
  );
}
