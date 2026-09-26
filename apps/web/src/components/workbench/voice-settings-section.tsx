"use client";

import type {
  VoiceDiagnoseReport,
  VoiceModelCandidate,
  VoiceSelection,
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
 * 设置 → 语音（规划 §7）。
 *
 * 三条产品口径写死在界面上：
 * 1. **未选择 = 不下载**：离线候选只有被选中后才出现「下载」按钮（按钮上标体积）；
 * 2. **不摆空壳、不放假开关**：不可选的候选置灰并写明原因（`unavailableReason`），
 *    不提供点了不生效的开关；
 * 3. **检测不删功能**：性能不足只给红字警告与实测代价，功能照旧可用。
 */

type SegmentKey = "listen" | "think" | "speak";

const SEGMENTS: Array<{ key: SegmentKey; title: string; hint: string }> = [
  { key: "listen", title: "听", hint: "把你说的话转成文字" },
  { key: "think", title: "想", hint: "把模糊的话补成完整需求" },
  { key: "speak", title: "说", hint: "用语音把回复念出来" },
];

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
      setMessage(error instanceof Error ? error.message : "无法读取语音设置。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 有下载在途时轮询（进度条要动起来）。 */
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
              // 速度读数可能缺席（端点不给 usage）：缺席就不传，别塞个 undefined
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
        // 广播给同一页面的输入框：不广播的话它们挂载时读到的还是旧模式，
        // 用户在这里切到「完整回路」、回去按住说话却按旧档走（真机点出来过）。
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
    (segment: SegmentKey, candidate: VoiceModelCandidate | null) => {
      const selection: VoiceSelection | null = candidate
        ? {
            kind: candidate.kind,
            id: candidate.id,
            ...(candidate.model ? { model: candidate.model } : {}),
          }
        : null;
      return patch(
        { [segment]: selection } as Record<string, unknown>,
        segment,
      );
    },
    [patch],
  );

  const modelAction = useCallback(
    async (action: "download" | "cancel" | "remove", modelId: string) => {
      setBusy(modelId);
      setMessage(null);
      try {
        const response =
          action === "download"
            ? await downloadVoiceModel(accessToken, modelId)
            : action === "cancel"
              ? await cancelVoiceModelDownload(accessToken, modelId)
              : await removeVoiceModel(accessToken, modelId);
        setModels((current) =>
          current.map((model) =>
            model.id === modelId ? response.model : model,
          ),
        );
        // 下载失败的原因在状态里（服务端留痕）：拉一次全量把错误显示出来
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
    return <ListLoading label="正在读取语音设置…" rows={3} />;
  }

  return (
    <section className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">语音</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          按住输入框说话，松开转文字。听 / 想 / 说 三段可以各用不同模型。
        </p>
      </div>

      {/* 功能模式 */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">功能模式</p>
        <fieldset aria-label="功能模式" className="min-w-0 space-y-2">
          {[
            {
              value: "transcribe" as const,
              title: "只转文本（默认）",
              description: "松开后把文字填进输入框，你自己确认再发送。",
            },
            {
              value: "loop" as const,
              title: "完整回路（听 → 想 → 说）",
              description:
                "自动把话补成完整需求并起一轮执行；可按下面的开关朗读回复。",
            },
          ].map((option) => (
            <label
              key={option.value}
              className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
                settings.mode === option.value
                  ? "border-primary/60 bg-primary/5"
                  : ""
              }`}
            >
              <input
                type="radio"
                name="voice-mode"
                value={option.value}
                checked={settings.mode === option.value}
                onChange={() => void patch({ mode: option.value }, "mode")}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{option.title}</span>
                <span className="mt-0.5 block text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      {/* 三段选择器 */}
      {SEGMENTS.map((segment) => (
        <div key={segment.key} className="space-y-2">
          <div>
            <p className="text-xs text-muted-foreground">
              {segment.title}：
              <span className="ml-1 text-foreground">
                {selectedLabel(settings[segment.key], models, segment.key)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">{segment.hint}</p>
          </div>
          <fieldset
            aria-label={`${segment.title}段模型`}
            className="min-w-0 space-y-2"
          >
            <label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
              <input
                type="radio"
                name={`voice-${segment.key}`}
                value="none"
                checked={settings[segment.key] === null}
                onChange={() => void select(segment.key, null)}
              />
              不用
            </label>
            {candidatesFor(models, segment.key).map((candidate) => (
              <CandidateCard
                key={`${candidate.kind}:${candidate.id}:${candidate.model ?? ""}`}
                candidate={candidate}
                selected={isSelected(settings[segment.key], candidate)}
                busy={busy === candidate.id}
                onSelect={() => void select(segment.key, candidate)}
                onAction={(action) => void modelAction(action, candidate.id)}
              />
            ))}
          </fieldset>
        </div>
      ))}

      {/* 语音回复开关（方案 B 的配套） */}
      {settings.mode === "loop" ? (
        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span className="text-xs">
            朗读回复
            <span className="mt-0.5 block text-muted-foreground">
              执行完把回复念出来（需要「说」段可用）。
            </span>
          </span>
          <input
            type="checkbox"
            aria-label="朗读回复"
            checked={settings.speakReplies}
            onChange={(event) =>
              void patch({ speakReplies: event.target.checked }, "speakReplies")
            }
            className="h-4 w-4"
          />
        </label>
      ) : null}

      {/* 检测报告 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">性能检测</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={diagnosing}
              onClick={() => void runDiagnose()}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
            >
              {diagnosing ? "检测中…" : "重新检测"}
            </button>
            <button
              type="button"
              disabled={busy === "advice"}
              onClick={() => void applyAdvice()}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
            >
              应用推荐
            </button>
          </div>
        </div>
        {report ? (
          <div className="space-y-1.5 rounded-lg border p-3 text-xs">
            <p className="text-muted-foreground">
              {report.hardware.cpuModel} · {report.hardware.cpuCores} 核 ·{" "}
              {formatBytes(report.hardware.totalMemoryBytes)} 内存
              {report.hardware.gpu ? ` · ${report.hardware.gpu}` : ""}
            </p>
            {/*
              规划 §3.4：探到 NVIDIA GPU 就提示「可接 GPU 服务」。本机 GPU 的用法是
              把「听 / 说」指到那个端点（`openai-compatible` 那条路），不另做一套
              配置通道；探不到就什么都不提，功能一点不受影响。
            */}
            {report.hardware.gpu ? (
              <p className="text-muted-foreground">
                可接 GPU 服务：把「听 / 说」指向本机跑的 GPU 端点（Speaches /
                faster-whisper 之类，填它的 OpenAI 兼容地址即可），比本机 CPU
                快得多。
              </p>
            ) : null}
            {(["listen", "think", "speak"] as const).map((key) => (
              <p
                key={key}
                className={
                  report[key].state === "unavailable"
                    ? "text-muted-foreground"
                    : "text-foreground"
                }
              >
                {SEGMENTS.find((segment) => segment.key === key)?.title}：
                {report[key].summary}
              </p>
            ))}
            {advice.reasons.length > 0 ? (
              <p className="pt-1 text-muted-foreground">
                建议：
                {advice.recommendedMode === "loop" ? "完整回路" : "只转文本"}
                {advice.recommendedSpeakReplies ? " + 朗读回复" : ""}
                （点「应用推荐」采纳）
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            还没检测过。检测会量一遍硬件与三段的实测耗时，约几秒。
          </p>
        )}
      </div>

      {message ? (
        <p role="status" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function candidatesFor(
  models: VoiceModelCandidate[],
  segment: SegmentKey,
): VoiceModelCandidate[] {
  return models.filter((model) => model.segment === segment);
}

function isSelected(
  selection: VoiceSelection | null,
  candidate: VoiceModelCandidate,
): boolean {
  if (!selection) {
    return false;
  }
  return (
    selection.kind === candidate.kind &&
    selection.id === candidate.id &&
    (selection.model ?? undefined) === candidate.model
  );
}

/** 当前选中的可读名（认不出的 id 原样显示：那是配置漂移，别藏起来）。 */
function selectedLabel(
  selection: VoiceSelection | null,
  models: VoiceModelCandidate[],
  segment: SegmentKey,
): string {
  if (!selection) {
    return "不用";
  }
  const match = candidatesFor(models, segment).find((candidate) =>
    isSelected(selection, candidate),
  );
  return match?.label ?? `${selection.id}（目录里已找不到，请重选）`;
}

function CandidateCard({
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
  const unavailable = Boolean(candidate.unavailableReason);
  const download = candidate.download;
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        selected ? "border-primary/60 bg-primary/5" : ""
      } ${unavailable ? "opacity-70" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="min-w-0 flex-1 text-left">
          <input
            type="radio"
            name={candidate.segment ? `voice-${candidate.segment}` : undefined}
            value={`${candidate.kind}:${candidate.id}:${candidate.model ?? ""}`}
            checked={selected}
            disabled={unavailable}
            onChange={onSelect}
            className="mr-2"
          />
          <span className="font-medium">{candidate.label}</span>
          <span className="mt-0.5 block text-muted-foreground">
            {candidate.kind === "builtin" ? "离线 · 本机 CPU" : "在线 · 端点"}
            {candidate.sizeBytes > 0
              ? ` · ${formatBytes(candidate.sizeBytes)}`
              : ""}
            {candidate.performanceNote ? ` · ${candidate.performanceNote}` : ""}
          </span>
          {candidate.unavailableReason ? (
            <span className="mt-0.5 block text-destructive">
              {candidate.unavailableReason}
            </span>
          ) : null}
          {download.error ? (
            <span className="mt-0.5 block text-destructive">
              {download.error}
            </span>
          ) : null}
        </label>
        {candidate.needsDownload ? (
          <DownloadControl
            state={download.state}
            busy={busy}
            onAction={onAction}
          />
        ) : null}
      </div>
      {download.state === "downloading" ? (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-muted">
          <div
            role="progressbar"
            aria-valuenow={Math.round(
              (download.downloadedBytes / Math.max(1, download.totalBytes)) *
                100,
            )}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-full bg-primary"
            style={{
              width: `${Math.min(
                100,
                (download.downloadedBytes / Math.max(1, download.totalBytes)) *
                  100,
              )}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 下载状态机：未下载→「下载」；下载中→进度 + 「取消」；就绪→「删除」。 */
function DownloadControl({
  state,
  busy,
  onAction,
}: {
  state: VoiceModelCandidate["download"]["state"];
  busy: boolean;
  onAction: (action: "download" | "cancel" | "remove") => void;
}) {
  if (state === "downloading") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onAction("cancel")}
        className="shrink-0 rounded-md border px-2 py-1 disabled:opacity-50"
      >
        取消
      </button>
    );
  }
  if (state === "ready") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onAction("remove")}
        className="shrink-0 rounded-md border px-2 py-1 disabled:opacity-50"
      >
        删除
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onAction("download")}
      className="shrink-0 rounded-md border px-2 py-1 disabled:opacity-50"
    >
      下载
    </button>
  );
}
