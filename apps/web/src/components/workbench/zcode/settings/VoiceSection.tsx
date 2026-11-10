import type {
  VoiceDiagnoseReport,
  VoiceModelCandidate,
  VoiceSettings,
} from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import { LoaderCircleIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
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
  { key: "listen", label: "转换模型" },
  { key: "think", label: "思考模型" },
  { key: "speak", label: "朗读模型" },
];

export interface VoiceDataClient {
  request<T>(path: string, body?: unknown): Promise<T>;
  requestWithSignal<T>(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<T>;
  putRequest<T>(path: string, body: unknown): Promise<T>;
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
        const response = await client.putRequest<{ settings: VoiceSettings }>(
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

  const recommendation = useMemo(() => recommendVoiceModels(models), [models]);

  const selectByValue = useCallback(
    (segment: SegmentKey, value: string) => {
      if (value === "none") return patch({ [segment]: null }, segment);
      const candidate = models.find((model) => modelValue(model) === value);
      if (!candidate) return Promise.resolve();
      return patch(
        {
          [segment]: {
            kind: candidate.kind,
            id: candidate.id,
            ...(candidate.model ? { model: candidate.model } : {}),
          },
        },
        segment,
      );
    },
    [models, patch],
  );

  const applyAdvice = useCallback(() => {
    const body: Record<string, unknown> = {
      mode: advice.recommendedMode,
      speakReplies: advice.recommendedSpeakReplies,
    };
    for (const segment of SEGMENTS) {
      const pick = recommendation[segment.key];
      if (!pick) continue;
      body[segment.key] = {
        kind: pick.kind,
        id: pick.id,
        ...(pick.model ? { model: pick.model } : {}),
      };
    }
    void patch(body, "advice");
  }, [advice, patch, recommendation]);

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
        {/* 语音模式 + 三段模型：一张卡片 */}
        <div className="w-full overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
            <span className="text-ui-base text-foreground">语音模式</span>
            <fieldset className="min-w-0" aria-label="语音模式">
              <div className="inline-flex rounded-full bg-background p-0.5">
                {(
                  [
                    { value: "transcribe" as const, label: "只转文本" },
                    { value: "loop" as const, label: "完整回路" },
                  ] satisfies Array<{
                    value: VoiceSettings["mode"];
                    label: string;
                  }>
                ).map((option) => (
                  <label
                    key={option.value}
                    className="cursor-pointer rounded-full px-3 py-1 text-ui-sm font-medium text-foreground-subtle transition-colors has-[:checked]:bg-card has-[:checked]:text-foreground has-[:checked]:shadow-xs"
                  >
                    <input
                      type="radio"
                      name="voice-mode"
                      value={option.value}
                      checked={settings.mode === option.value}
                      onChange={() => void patch({ mode: option.value }, "mode")}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          {SEGMENTS.filter(
            (segment) => settings.mode === "loop" || segment.key === "listen",
          ).map((segment) => (
            <div
              key={segment.key}
              className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <span className="text-ui-base text-foreground">
                {segment.label}
              </span>
              <Select
                value={selectionValue(settings[segment.key])}
                onValueChange={(value) => void selectByValue(segment.key, value)}
              >
                <SelectTrigger size="lg" className="w-[240px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top" align="end">
                  <SelectItem value="none">不用</SelectItem>
                  {models
                    .filter((model) => model.segment === segment.key)
                    .map((candidate) => (
                      <SelectItem
                        key={modelValue(candidate)}
                        value={modelValue(candidate)}
                        disabled={Boolean(candidate.unavailableReason)}
                      >
                        {candidate.label}
                        {candidate.unavailableReason === undefined
                          ? ` · ${candidateMeta(candidate)}`
                          : ` · ${candidate.unavailableReason}`}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        {/* 性能检测：硬件 + 每段推荐 */}
        <div className="w-full overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex w-full items-center justify-between gap-2 px-4 py-3">
            <span className="text-ui-base font-medium text-foreground">
              性能检测
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  diagnosing
                    ? diagnoseAbort.current?.abort()
                    : void runDiagnose()
                }
              >
                {diagnosing ? (
                  <>
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                    取消检测
                  </>
                ) : (
                  "重新检测"
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy === "advice"}
                onClick={applyAdvice}
              >
                应用推荐
              </Button>
            </div>
          </div>
          {report ? (
            <div className="w-full space-y-1 border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">
              <p>
                CPU {report.hardware.cpuModel} · {report.hardware.cpuCores} 核 ·
                内存 {formatBytes(report.hardware.totalMemoryBytes)}
              </p>
              <p>
                GPU {report.hardware.gpu ?? "未探到"}
                {report.hardware.gpuMemoryBytes === undefined
                  ? ""
                  : ` · 显存 ${formatBytes(report.hardware.gpuMemoryBytes)}`}
              </p>
              <p className="pt-1 text-foreground">推荐模型</p>
              {SEGMENTS.map((segment) => {
                const pick = recommendation[segment.key];
                return (
                  <p key={segment.key}>
                    {segment.label}{" "}
                    {pick
                      ? `${pick.label}（${pick.kind === "builtin" ? "本机" : "在线"}） · ${segmentMetric(report, segment.key, pick)}`
                      : "无可用模型"}
                  </p>
                );
              })}
              {performanceWarning ? (
                <p className="text-destructive">{performanceWarning}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        {message ? (
          <p role="status" className="text-ui-base text-destructive">
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

function modelValue(candidate: VoiceModelCandidate): string {
  return `${candidate.kind}:${candidate.id}:${candidate.model ?? ""}`;
}

function selectionValue(selection: VoiceSettings[SegmentKey]): string {
  if (!selection) return "none";
  return `${selection.kind}:${selection.id}:${selection.model ?? ""}`;
}

/** 选择器里的一行标签：来源 + 体积，够选就行（速度与结论在检测卡片）。 */
function candidateMeta(candidate: VoiceModelCandidate): string {
  const source = candidate.kind === "builtin" ? "离线" : "在线";
  return candidate.sizeBytes > 0
    ? `${source} · ${formatBytes(candidate.sizeBytes)}`
    : source;
}

/**
 * 每段的速度读数：实测优先，未实测才回退到候选的预估标注；
 * 在线端点没有统一读数，未实测就说「未实测」。
 */
function segmentMetric(
  report: VoiceDiagnoseReport | null,
  segment: SegmentKey,
  pick: VoiceModelCandidate,
): string {
  const measured = report?.[segment];
  if (measured?.state === "measured") {
    return measured.summary;
  }
  return pick.kind === "instance" ? "未实测" : (pick.performanceNote ?? "未实测");
}

/** 每段的首选来源：听/说优先本机离线（离线、隐私），想优先在线实例（质量）。 */
const SEGMENT_PREFERENCE: Record<SegmentKey, "builtin" | "instance"> = {
  listen: "builtin",
  think: "instance",
  speak: "builtin",
};

/** 每段的推荐模型：同段可选项里按首选来源挑，没有再退回同段第一项。 */
export function recommendVoiceModels(
  candidates: readonly VoiceModelCandidate[],
): Partial<Record<SegmentKey, VoiceModelCandidate>> {
  const usable = candidates.filter(
    (candidate) => candidate.unavailableReason === undefined,
  );
  const picked: Partial<Record<SegmentKey, VoiceModelCandidate>> = {};
  for (const segment of ["listen", "think", "speak"] as const) {
    const pool = usable.filter((candidate) => candidate.segment === segment);
    const choice =
      pool.find((candidate) => candidate.kind === SEGMENT_PREFERENCE[segment]) ??
      pool[0];
    if (choice) picked[segment] = choice;
  }
  return picked;
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
    parts.push(`听 ${(1 / rtf).toFixed(1)} 倍速`);
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
        : ` · ${think.tokensPerSecond.toFixed(0)} tok/s`;
    parts.push(`想 首字 ${think.ttftSeconds.toFixed(2)}s${speed}`);
  }
  return parts.length > 0 ? `${parts.join(" · ")} · 建议只转文本` : null;
}
