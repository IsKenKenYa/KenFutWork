"use client";

import type {
  VoiceDiagnoseReport,
  VoiceModelCandidate,
  VoiceSettings,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import { VOICE_SETTINGS_CHANGED_EVENT } from "@/components/composer-voice";
import { formatBytes } from "@/components/workbench/index-library-section";
import { ListLoading } from "@/components/workbench/list-state";
import {
  cancelVoiceModelDownload,
  downloadVoiceModel,
  fetchVoiceDiagnose,
  fetchVoiceModels,
  fetchVoiceSettings,
  removeVoiceModel,
  runVoiceDiagnose,
  updateVoiceSettings,
} from "@/lib/server-api";
import {
  adviseVoiceProfile,
  gradeAsrRtf,
  gradeLlm,
  type VoiceProfileAdvice,
} from "@/lib/voice-profile";

/**
 * 设置 → 语音。
 *
 * **文案只写标签，不写句子**（用户口径 2026-09-27）：不解释「松开后会怎样」、
 * 不推导性能、不把需求或实现说明抄进界面——一眼看完才算合格。
 * 方案与理由留在 docs/插件/语音助手插件规划.md 与代码注释里。
 */

type SegmentKey = "listen" | "think" | "speak";

const SEGMENTS: Array<{ key: SegmentKey; label: string }> = [
  { key: "listen", label: "听" },
  { key: "think", label: "想" },
  { key: "speak", label: "说" },
];

/**
 * 设置里所有行同一几何：与输入框同高同字号、宽度铺满，`min-h` 定成 2.625rem（42px）。
 *
 * `min-h` 不是凑数：同一段候选列表里，「不用」行没有尾控件、「下载/删除」行有——
 * 不兜底就是 38px 与 42px 交替（真机量过；用户反馈「排版不合理」）。兜在行上比在
 * 每行手工插一个空占位元素干净：空占位正是刚被门禁判为「删文案剩的壳」的那类东西。
 */
const ROW_CLASS =
  "flex w-full min-h-[2.625rem] items-center gap-2 rounded-lg border px-3 py-2 text-sm";

export function VoiceSettingsSection({ accessToken }: { accessToken: string }) {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [models, setModels] = useState<VoiceModelCandidate[]>([]);
  const [report, setReport] = useState<VoiceDiagnoseReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [settingsResponse, modelsResponse, diagnoseResponse] =
        await Promise.all([
          fetchVoiceSettings(accessToken),
          fetchVoiceModels(accessToken),
          fetchVoiceDiagnose(accessToken),
        ]);
      setSettings(settingsResponse.settings);
      setModels(modelsResponse.models);
      setReport(diagnoseResponse.report);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取失败。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const downloading = models.some(
    (model) => model.download.state === "downloading",
  );
  useEffect(() => {
    if (!downloading) {
      return;
    }
    const timer = setInterval(() => {
      void fetchVoiceModels(accessToken)
        .then((response) => setModels(response.models))
        .catch(() => undefined);
    }, 1_000);
    return () => clearInterval(timer);
  }, [accessToken, downloading]);

  const advice: VoiceProfileAdvice = useMemo(
    () =>
      adviseVoiceProfile({
        ...(report?.listen.state === "measured" &&
        report.listen.listen?.rtfMedian !== undefined
          ? { asr: gradeAsrRtf(report.listen.listen.rtfMedian) }
          : {}),
        ...(report?.think.state === "measured" && report.think.think
          ? {
              llm: gradeLlm({
                ttftSeconds: report.think.think.ttftSeconds,
                ...(report.think.think.tokensPerSecond === undefined
                  ? {}
                  : { tokensPerSecond: report.think.think.tokensPerSecond }),
              }),
            }
          : {}),
      }),
    [report],
  );

  const patch = useCallback(
    async (body: Parameters<typeof updateVoiceSettings>[1], label: string) => {
      setBusy(label);
      setMessage(null);
      try {
        const response = await updateVoiceSettings(accessToken, body);
        setSettings(response.settings);
        // 同页输入框据此立刻换档，不必重载页面
        window.dispatchEvent(
          new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, {
            detail: response.settings,
          }),
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "保存失败。");
      } finally {
        setBusy(null);
      }
    },
    [accessToken],
  );

  const select = useCallback(
    (segment: SegmentKey, candidate: VoiceModelCandidate | null) =>
      patch(
        {
          [segment]: candidate
            ? {
                kind: candidate.kind,
                id: candidate.id,
                ...(candidate.model ? { model: candidate.model } : {}),
              }
            : null,
        } as Record<string, unknown>,
        segment,
      ),
    [patch],
  );

  const modelAction = useCallback(
    async (action: "download" | "cancel" | "remove", modelId: string) => {
      setBusy(modelId);
      setMessage(null);
      try {
        await (action === "download"
          ? downloadVoiceModel(accessToken, modelId)
          : action === "cancel"
            ? cancelVoiceModelDownload(accessToken, modelId)
            : removeVoiceModel(accessToken, modelId));
        const refreshed = await fetchVoiceModels(accessToken);
        setModels(refreshed.models);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "操作失败。");
      } finally {
        setBusy(null);
      }
    },
    [accessToken],
  );

  const runDiagnose = useCallback(async () => {
    setDiagnosing(true);
    setMessage(null);
    try {
      const response = await runVoiceDiagnose(accessToken);
      setReport(response.report);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "检测失败。");
    } finally {
      setDiagnosing(false);
    }
  }, [accessToken]);

  const applyAdvice = useCallback(async () => {
    await patch(
      {
        mode: advice.recommendedMode,
        speakReplies: advice.recommendedSpeakReplies,
      },
      "advice",
    );
  }, [advice, patch]);

  if (loading || !settings) {
    return <ListLoading label="读取中…" rows={2} />;
  }

  return (
    <section aria-label="语音" className="w-full space-y-5">
      <fieldset aria-label="模式" className="w-full min-w-0 space-y-2">
        {(
          [
            { value: "transcribe" as const, label: "只转文本" },
            { value: "loop" as const, label: "完整回路" },
          ] satisfies Array<{ value: VoiceSettings["mode"]; label: string }>
        ).map((option) => (
          <label
            key={option.value}
            className={`${ROW_CLASS} cursor-pointer ${
              settings.mode === option.value ? "border-foreground" : ""
            }`}
          >
            <input
              type="radio"
              name="voice-mode"
              value={option.value}
              checked={settings.mode === option.value}
              onChange={() => void patch({ mode: option.value }, "mode")}
              className="shrink-0"
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      {SEGMENTS.map((segment) => (
        <fieldset
          key={segment.key}
          aria-label={`${segment.label}段模型`}
          className="w-full min-w-0 space-y-2"
        >
          <legend className="text-sm text-muted-foreground">
            {segment.label}：
            {selectedLabel(settings[segment.key], models, segment.key)}
          </legend>
          <label className={`${ROW_CLASS} cursor-pointer`}>
            <input
              type="radio"
              name={`voice-${segment.key}`}
              value="none"
              checked={settings[segment.key] === null}
              onChange={() => void select(segment.key, null)}
              className="shrink-0"
            />
            不用
          </label>
          {candidatesFor(models, segment.key).map((candidate) => (
            <CandidateRow
              key={`${candidate.kind}:${candidate.id}:${candidate.model ?? ""}`}
              candidate={candidate}
              selected={isSelected(settings[segment.key], candidate)}
              busy={busy === candidate.id}
              onSelect={() => void select(segment.key, candidate)}
              onAction={(action) => void modelAction(action, candidate.id)}
            />
          ))}
        </fieldset>
      ))}

      {settings.mode === "loop" ? (
        <label className={`${ROW_CLASS} cursor-pointer justify-between`}>
          <span>朗读回复</span>
          <input
            type="checkbox"
            aria-label="朗读回复"
            checked={settings.speakReplies}
            onChange={(event) =>
              void patch({ speakReplies: event.target.checked }, "speakReplies")
            }
            className="shrink-0"
          />
        </label>
      ) : null}

      <div className="w-full space-y-2">
        <div className="flex w-full items-center gap-2">
          <span className="text-sm text-muted-foreground">性能检测</span>
          <button
            type="button"
            disabled={diagnosing}
            onClick={() => void runDiagnose()}
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {diagnosing ? "检测中…" : "重新检测"}
          </button>
          <button
            type="button"
            disabled={busy === "advice"}
            onClick={() => void applyAdvice()}
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            应用推荐
          </button>
        </div>
        {report ? (
          <div className="w-full space-y-1 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
            <p>
              {report.hardware.cpuCores} 核 ·{" "}
              {formatBytes(report.hardware.totalMemoryBytes)}
              {report.hardware.gpu ? ` · ${report.hardware.gpu}` : ""}
            </p>
            <p>
              听 {listenMetric(report)} · 想 {thinkMetric(report)} · 说{" "}
              {speakMetric(report)}
            </p>
            <p>
              推荐{" "}
              {advice.recommendedMode === "loop"
                ? advice.recommendedSpeakReplies
                  ? "完整回路 + 朗读"
                  : "完整回路"
                : "只转文本"}
            </p>
            {report.hardware.gpu ? (
              <p>可接 GPU 服务：{report.hardware.gpu}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {message ? (
        <p role="status" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** 段的实测读数（只给数字，不写成句子）。 */
function listenMetric(report: VoiceDiagnoseReport): string {
  const rtf = report.listen.listen?.rtfMedian;
  if (rtf === undefined) {
    return report.listen.state === "unavailable" ? "不可用" : "未实测";
  }
  const load = report.listen.listen?.modelLoadMs;
  return load === undefined
    ? `${rtf.toFixed(2)}×`
    : `${rtf.toFixed(2)}× 首载 ${(load / 1000).toFixed(1)}s`;
}

function thinkMetric(report: VoiceDiagnoseReport): string {
  const ttft = report.think.think?.ttftSeconds;
  if (ttft === undefined) {
    return report.think.state === "unavailable" ? "不可用" : "未实测";
  }
  const speed = report.think.think?.tokensPerSecond;
  return speed === undefined
    ? `${ttft.toFixed(2)}s`
    : `${ttft.toFixed(2)}s ${speed.toFixed(0)}t/s`;
}

function speakMetric(report: VoiceDiagnoseReport): string {
  const match = report.speak.summary.match(/首包 ([\d.]+)s、实时率 ([\d.]+)/);
  if (match) {
    return `${match[2]}× 首包 ${match[1]}s`;
  }
  return report.speak.state === "unavailable" ? "不可用" : "未实测";
}

function candidatesFor(
  models: VoiceModelCandidate[],
  segment: SegmentKey,
): VoiceModelCandidate[] {
  return models.filter((model) => model.segment === segment);
}

function isSelected(
  selection: VoiceSettings[SegmentKey],
  candidate: VoiceModelCandidate,
): boolean {
  return Boolean(
    selection &&
      selection.kind === candidate.kind &&
      selection.id === candidate.id &&
      (selection.model ?? undefined) === candidate.model,
  );
}

function selectedLabel(
  selection: VoiceSettings[SegmentKey],
  models: VoiceModelCandidate[],
  segment: SegmentKey,
): string {
  if (!selection) {
    return "不用";
  }
  return (
    candidatesFor(models, segment).find((candidate) =>
      isSelected(selection, candidate),
    )?.label ?? selection.id
  );
}

function CandidateRow({
  candidate,
  selected,
  busy,
  onSelect,
  onAction,
}: {
  candidate: VoiceModelCandidate;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAction: (action: "download" | "cancel" | "remove") => void;
}) {
  const download = candidate.download;
  return (
    <label
      className={`${ROW_CLASS} ${
        selected ? "border-foreground" : ""
      } ${candidate.unavailableReason ? "opacity-60" : ""}`}
    >
      <input
        type="radio"
        name={`voice-${candidate.segment}`}
        value={`${candidate.kind}:${candidate.id}:${candidate.model ?? ""}`}
        checked={selected}
        disabled={Boolean(candidate.unavailableReason)}
        onChange={onSelect}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1">
        {candidate.label}
        <span className="ml-2 text-xs text-muted-foreground">
          {candidateMeta(candidate)}
        </span>
        {candidate.unavailableReason ? (
          <span className="ml-2 text-xs text-destructive">
            {candidate.unavailableReason}
          </span>
        ) : null}
        {download.error ? (
          <span className="ml-2 text-xs text-destructive">
            {download.error}
          </span>
        ) : null}
      </span>
      {candidate.needsDownload ? (
        <DownloadControl
          state={download.state}
          percent={Math.round(
            (download.downloadedBytes / Math.max(1, download.totalBytes)) * 100,
          )}
          busy={busy}
          onAction={onAction}
        />
      ) : null}
    </label>
  );
}

/** 候选的元信息：来源 · 体积 · 性能（数字，不是句子）。 */
function candidateMeta(candidate: VoiceModelCandidate): string {
  const parts = [candidate.kind === "builtin" ? "离线" : "在线"];
  if (candidate.sizeBytes > 0) {
    parts.push(formatBytes(candidate.sizeBytes));
  }
  if (candidate.performanceNote) {
    parts.push(candidate.performanceNote);
  }
  return parts.join(" · ");
}

function DownloadControl({
  state,
  percent,
  busy,
  onAction,
}: {
  state: VoiceModelCandidate["download"]["state"];
  percent: number;
  busy: boolean;
  onAction: (action: "download" | "cancel" | "remove") => void;
}) {
  const label =
    state === "downloading"
      ? `取消 ${percent}%`
      : state === "ready"
        ? "删除"
        : "下载";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(event) => {
        // 按钮包在 label 里：点它不该顺带改选择
        event.preventDefault();
        onAction(
          state === "downloading"
            ? "cancel"
            : state === "ready"
              ? "remove"
              : "download",
        );
      }}
      className="inline-flex h-6 shrink-0 items-center rounded-md border px-3 text-xs disabled:opacity-50"
    >
      {label}
    </button>
  );
}
