import type {
  VoiceDiagnoseReport,
  VoiceModelCandidate,
  VoiceSettings,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 设置 → 语音（code-ui 管理文档分区）。
 *
 * KenFutWork 语音助手（听/想/说）的档位、模型下载与性能检测；数据面是本机
 * 服务端 `/api/voice/*`（cookie 认证，经宿主 client 的统一 apiBase）。
 * 文案只写标签，不写句子（用户口径 2026-09-27）；检测不足给数字读数，
 * 理由与推导留在 docs/插件/语音助手插件规划.md。检测阈值与 web 侧
 * `lib/voice-profile.ts` 同口径（RTF ≤ 1、TTFT ≤ 3s、速率 ≥ 5t/s）。
 */

type SegmentKey = "listen" | "think" | "speak";

const SEGMENTS: Array<{ key: SegmentKey; label: string }> = [
  { key: "listen", label: "听" },
  { key: "think", label: "想" },
  { key: "speak", label: "说" },
];

const LOCATION_LABELS: Record<VoiceModelCandidate["location"], string> = {
  cpu: "本机 CPU",
  gpu: "本机 GPU",
  remote: "远端",
};

export interface VoiceDataClient {
  request<T>(path: string, body?: unknown): Promise<T>;
  requestWithSignal<T>(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<T>;
  deleteRequest<T>(path: string): Promise<T>;
}

export function VoiceSection({ client }: { client: VoiceDataClient }) {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [models, setModels] = useState<VoiceModelCandidate[]>([]);
  const [report, setReport] = useState<VoiceDiagnoseReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const diagnoseAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const [settingsResponse, modelsResponse, diagnoseResponse] =
        await Promise.all([
          client.request<{ settings: VoiceSettings }>("/api/voice/settings"),
          client.request<{ models: VoiceModelCandidate[] }>(
            "/api/voice/models",
          ),
          client.request<{ report: VoiceDiagnoseReport | null }>(
            "/api/voice/diagnose",
          ),
        ]);
      setSettings(settingsResponse.settings);
      setModels(modelsResponse.models);
      setReport(diagnoseResponse.report);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const downloading = models.some(
    (model) => model.download.state === "downloading",
  );
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => {
      void client
        .request<{ models: VoiceModelCandidate[] }>("/api/voice/models")
        .then((response) => setModels(response.models))
        .catch(() => undefined);
    }, 1_000);
    return () => clearInterval(timer);
  }, [client, downloading]);

  const advice = useMemo(() => adviceOf(report), [report]);
  const performanceWarning = useMemo(
    () => (report ? insufficientNote(report, advice) : null),
    [advice, report],
  );

  const patch = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      setBusy(label);
      setMessage(null);
      try {
        const response = await client.request<{ settings: VoiceSettings }>(
          "/api/voice/settings",
          body,
        );
        setSettings(response.settings);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "保存失败");
      } finally {
        setBusy(null);
      }
    },
    [client],
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
        },
        segment,
      ),
    [patch],
  );

  const modelAction = useCallback(
    async (action: "download" | "cancel" | "remove", modelId: string) => {
      setBusy(modelId);
      setMessage(null);
      const id = encodeURIComponent(modelId);
      try {
        if (action === "download") {
          await client.request(`/api/voice/models/${id}/download`, {});
        } else if (action === "cancel") {
          await client.deleteRequest(`/api/voice/models/${id}/download`);
        } else {
          await client.deleteRequest(`/api/voice/models/${id}`);
        }
        const refreshed = await client.request<{
          models: VoiceModelCandidate[];
        }>("/api/voice/models");
        setModels(refreshed.models);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "操作失败");
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const runDiagnose = useCallback(async () => {
    const controller = new AbortController();
    diagnoseAbort.current = controller;
    setDiagnosing(true);
    setMessage(null);
    try {
      const response = await client.requestWithSignal<{
        report: VoiceDiagnoseReport;
      }>("/api/voice/diagnose", {}, controller.signal);
      setReport(response.report);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "检测失败");
      }
    } finally {
      if (diagnoseAbort.current === controller) {
        diagnoseAbort.current = null;
        setDiagnosing(false);
      }
    }
  }, [client]);

  if (loading || !settings) {
    return (
      <div className="space-y-2 p-4 text-ui-sm text-foreground-subtle">
        读取中…
      </div>
    );
  }

  return (
    <section aria-label="语音" className="w-full space-y-4">
      <div className="space-y-3">
        {/* 两个模式横排：能左右就别说上下 */}
        <fieldset className="w-full min-w-0" aria-label="模式">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: "transcribe" as const, label: "只转文本" },
                { value: "loop" as const, label: "完整回路" },
              ] satisfies Array<{ value: VoiceSettings["mode"]; label: string }>
            ).map((option) => (
              <label
                key={option.value}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-ui-sm ${
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
          </div>
        </fieldset>

        {SEGMENTS.map((segment) => (
          <fieldset
            key={segment.key}
            aria-label={segment.label}
            className="w-full min-w-0 space-y-2"
          >
            <legend className="text-ui-sm text-foreground-subtle">
              {segment.label}：
              {selectedLabel(settings[segment.key], models, segment.key)}
            </legend>
            <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-ui-sm">
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
            {models
              .filter((model) => model.segment === segment.key)
              .map((candidate) => (
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
          <label className="flex w-full cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-ui-sm">
            <span>朗读回复</span>
            <input
              type="checkbox"
              aria-label="朗读回复"
              checked={settings.speakReplies}
              onChange={(event) =>
                void patch(
                  { speakReplies: event.target.checked },
                  "speakReplies",
                )
              }
              className="shrink-0"
            />
          </label>
        ) : null}

        <div className="w-full space-y-2">
          <div className="flex w-full items-center gap-2">
            <span className="text-ui-sm text-foreground-subtle">性能检测</span>
            <button
              type="button"
              onClick={() =>
                diagnosing ? diagnoseAbort.current?.abort() : void runDiagnose()
              }
              className="rounded-md border px-3 py-1.5 text-ui-sm disabled:opacity-50"
            >
              {diagnosing ? "取消检测" : "重新检测"}
            </button>
            <button
              type="button"
              disabled={busy === "advice"}
              onClick={() =>
                void patch(
                  {
                    mode: advice.recommendedMode,
                    speakReplies: advice.recommendedSpeakReplies,
                  },
                  "advice",
                )
              }
              className="rounded-md border px-3 py-1.5 text-ui-sm disabled:opacity-50"
            >
              应用推荐
            </button>
          </div>
          {report ? (
            <div className="w-full space-y-1 rounded-lg border px-3 py-2 text-ui-sm text-foreground-subtle">
              <p>
                {report.hardware.cpuModel} · {report.hardware.cpuCores} 核 ·{" "}
                {formatBytes(report.hardware.totalMemoryBytes)}
                {report.hardware.gpu ? ` · ${report.hardware.gpu}` : ""}
              </p>
              <p>{segmentSummary(report)}</p>
              <p>
                推荐{" "}
                {advice.recommendedMode === "loop"
                  ? advice.recommendedSpeakReplies
                    ? "完整回路 + 朗读"
                    : "完整回路"
                  : "只转文本"}
              </p>
              {performanceWarning ? (
                <p className="text-destructive">{performanceWarning}</p>
              ) : null}
              {report.hardware.gpu ? <p>可接 GPU 服务</p> : null}
            </div>
          ) : null}
        </div>

        {message ? (
          <p role="status" className="text-ui-sm text-destructive">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
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
    models
      .filter((model) => model.segment === segment)
      .find((candidate) => isSelected(selection, candidate))?.label ??
    selection.id
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
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-ui-sm ${
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
        <span className="ml-2 text-ui-sm text-foreground-subtle">
          {candidateMeta(candidate)}
        </span>
        {candidate.unavailableReason ? (
          <span className="ml-2 text-ui-sm text-destructive">
            {candidate.unavailableReason}
          </span>
        ) : null}
        {download.error ? (
          <span className="ml-2 text-ui-sm text-destructive">
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

function candidateMeta(candidate: VoiceModelCandidate): string {
  const parts = [candidate.kind === "builtin" ? "离线" : "在线"];
  if (candidate.sizeBytes > 0) {
    parts.push(formatBytes(candidate.sizeBytes));
  }
  parts.push(LOCATION_LABELS[candidate.location]);
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
        event.preventDefault();
        onAction(
          state === "downloading"
            ? "cancel"
            : state === "ready"
              ? "remove"
              : "download",
        );
      }}
      className="inline-flex h-6 shrink-0 items-center rounded-md border px-3 text-ui-sm disabled:opacity-50"
    >
      {label}
    </button>
  );
}

type VoiceProfileAdvice = {
  recommendedMode: VoiceSettings["mode"];
  recommendedSpeakReplies: boolean;
};

function adviceOf(report: VoiceDiagnoseReport | null): VoiceProfileAdvice {
  if (!report) {
    return { recommendedMode: "transcribe", recommendedSpeakReplies: false };
  }
  // 检测判定沿用 web 侧 lib/voice-profile 的阈值口径；这里只消费实测结论。
  const asrOk =
    report.listen.state !== "measured" ||
    (report.listen.listen?.rtfMedian !== undefined &&
      report.listen.listen.rtfMedian <= 1);
  const think = report.think.think;
  const llmOk =
    report.think.state !== "measured" ||
    !think ||
    (think.ttftSeconds <= 3 &&
      (think.tokensPerSecond === undefined || think.tokensPerSecond >= 5));
  return asrOk && llmOk
    ? { recommendedMode: "loop", recommendedSpeakReplies: false }
    : { recommendedMode: "transcribe", recommendedSpeakReplies: false };
}

function insufficientNote(
  report: VoiceDiagnoseReport,
  advice: VoiceProfileAdvice,
): string | null {
  if (advice.recommendedMode === "loop") {
    return null;
  }
  const parts: string[] = [];
  const rtf = report.listen.listen?.rtfMedian;
  if (report.listen.state === "measured" && rtf !== undefined && rtf > 1) {
    parts.push(`听 ${rtf.toFixed(2)}×`);
  }
  const think = report.think.think;
  if (
    report.think.state === "measured" &&
    think &&
    (think.ttftSeconds > 3 ||
      (think.tokensPerSecond !== undefined && think.tokensPerSecond < 5))
  ) {
    const speed =
      think.tokensPerSecond === undefined
        ? ""
        : ` ${think.tokensPerSecond.toFixed(0)}t/s`;
    parts.push(`想 ${think.ttftSeconds.toFixed(2)}s${speed}`);
  }
  return parts.length > 0 ? `${parts.join(" · ")} · 建议只转文本` : null;
}

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

function isStateMetric(value: string): boolean {
  return value === "不可用" || value === "未实测";
}

function segmentSummary(report: VoiceDiagnoseReport): string {
  const parts: Array<[string, string]> = [
    ["听", listenMetric(report)],
    ["想", thinkMetric(report)],
    ["说", speakMetric(report)],
  ];
  const merged: Array<{ labels: string[]; value: string }> = [];
  for (const [label, value] of parts) {
    const last = merged[merged.length - 1];
    if (last && last.value === value && isStateMetric(value)) {
      last.labels.push(label);
    } else {
      merged.push({ labels: [label], value });
    }
  }
  return merged
    .map((item) => `${item.labels.join("/")} ${item.value}`)
    .join(" · ");
}
