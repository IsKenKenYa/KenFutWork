import { Modal } from "@kenfutwork/context-insights-ui";
import type { ContextRequestSummary } from "@kenfutwork/shared";
import { type RefObject, useId, useLayoutEffect, useMemo } from "react";
import { mountContextInspectionIcons } from "./contextInspectionIcons.js";
import {
  buildContextTimeline,
  contextRequestPurposeLabels,
} from "./contextInspectionModel.js";
import type { InspectionCall } from "./contextInspectionReader.js";
import { ContextInspectionViews } from "./contextInspectionViews.js";
import { useContextInspection } from "./useContextInspection.js";
import "@kenfutwork/context-insights-ui/styles.css";
import "./contextInspection.css";

const statusLabels = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function ContextAttemptLinks({
  selected,
  requests,
  onSelect,
}: {
  selected: ContextRequestSummary;
  requests: readonly ContextRequestSummary[];
  onSelect: (id: string) => void;
}) {
  const callId = selected.attempt?.callId;
  if (!callId) return null;
  const related = requests
    .flatMap((request) =>
      request.attempt?.callId === callId &&
      request.runId === selected.runId &&
      request.agentCallId === selected.agentCallId &&
      request.purpose === selected.purpose
        ? [{ request, number: request.attempt.number }]
        : [],
    )
    .sort((a, b) => a.number - b.number);
  if (related.length < 2) return null;
  return (
    <nav className="context-inspection-attempts" aria-label="同次调用">
      <span>同次调用</span>
      {related.map(({ request, number }) => (
        <button
          key={request.id}
          type="button"
          aria-current={request.id === selected.id ? "true" : undefined}
          onClick={() => onSelect(request.id)}
        >
          第 {number} 次 · #{request.sequence}
        </button>
      ))}
    </nav>
  );
}

export default function ContextInspectionDialog({
  taskId,
  call,
  onClose,
  background,
}: {
  taskId: string;
  call: InspectionCall;
  onClose: () => void;
  background: RefObject<HTMLDivElement | null>;
}) {
  const titleId = useId();
  const state = useContextInspection(call, taskId);
  const data = useMemo(
    () => buildContextTimeline(state.inspected),
    [state.inspected],
  );
  useLayoutEffect(() => {
    const element = background.current;
    const wasInert = element?.inert ?? false;
    if (element) element.inert = true;
    const removeIcons = mountContextInspectionIcons();
    return () => {
      if (element) element.inert = wasInert;
      removeIcons();
    };
  }, [background]);
  return (
    <Modal
      headless
      open
      title="上下文分析"
      className="context-inspection"
      onClose={onClose}
      backdropBlur={false}
    >
      <div className="context-inspection-frame">
        <header className="context-inspection-header">
          <h1 id={titleId}>上下文分析</h1>
          <button
            type="button"
            aria-disabled={state.busy}
            onClick={() => {
              if (!state.busy) void state.refresh();
            }}
          >
            刷新
          </button>
          <button type="button" data-modal-autofocus onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="context-inspection-layout">
          <nav
            className="context-inspection-requests"
            aria-label="模型请求"
            aria-busy={state.busy}
          >
            <h2>请求记录</h2>
            {state.busy ? <p role="status">读取请求…</p> : null}
            {!state.busy && !state.error && !state.requests.length ? (
              <p>暂无请求记录</p>
            ) : null}
            <ol>
              {state.requests.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={
                      r.id === state.selected?.id ? "true" : undefined
                    }
                    onClick={() => state.select(r.id)}
                  >
                    <span>
                      #{r.sequence} · {statusLabels[r.status]}
                    </span>
                    <span>{r.model ?? "模型未知"}</span>
                    <span>{contextRequestPurposeLabels[r.purpose]}</span>
                    {r.attempt && r.attempt.number > 1 ? (
                      <span>第 {r.attempt.number} 次尝试</span>
                    ) : null}
                    <span>
                      {r.agentName ?? (r.agentCallId ? "子 Agent" : "主 Agent")}
                    </span>
                    <time dateTime={r.startedAt}>
                      {new Date(r.startedAt).toLocaleTimeString()}
                    </time>
                  </button>
                </li>
              ))}
            </ol>
            {state.nextBefore ? (
              <button
                type="button"
                disabled={state.busy}
                onClick={() => void state.loadMore()}
              >
                更早请求
              </button>
            ) : null}
          </nav>
          <div className="context-inspection-content lc-root">
            {state.error ? <p role="alert">{state.error}</p> : null}
            {state.reading ? (
              <div role="status">
                读取上下文…{" "}
                <button type="button" onClick={state.cancelRead}>
                  停止读取
                </button>
              </div>
            ) : null}
            {state.selected ? (
              <>
                <div className="context-inspection-summary">
                  <h2>请求 #{state.selected.sequence}</h2>
                  <dl>
                    {state.selected.attempt ? (
                      <div>
                        <dt>调用尝试</dt>
                        <dd>第 {state.selected.attempt.number} 次</dd>
                      </div>
                    ) : null}
                    {state.selected.httpStatus != null ? (
                      <div>
                        <dt>供应商状态</dt>
                        <dd>HTTP {state.selected.httpStatus}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>实际输入</dt>
                      <dd>{state.selected.usage?.inputTokens ?? "未知"}</dd>
                    </div>
                    <div>
                      <dt>实际输出</dt>
                      <dd>{state.selected.usage?.outputTokens ?? "未知"}</dd>
                    </div>
                    <div>
                      <dt>缓存输入</dt>
                      <dd>
                        {state.selected.usage?.cachedInputTokens ?? "未知"}
                      </dd>
                    </div>
                    <div>
                      <dt>工具定义</dt>
                      <dd>{state.selected.toolCount ?? "未记录"}</dd>
                    </div>
                  </dl>
                  <ContextAttemptLinks
                    selected={state.selected}
                    requests={state.requests}
                    onSelect={state.select}
                  />
                  <button
                    type="button"
                    disabled={state.reading}
                    onClick={() => void state.readHistory()}
                  >
                    读取历史上下文
                  </button>
                </div>
                {state.content ? (
                  <>
                    <ContextInspectionViews
                      data={data}
                      requestId={state.selected.id}
                      onSelect={state.select}
                    />
                    <details>
                      <summary>请求原文</summary>
                      <pre>{JSON.stringify(state.content.input, null, 2)}</pre>
                    </details>
                    <details>
                      <summary>模型响应</summary>
                      {state.outputPending ? (
                        <p>响应待重新读取</p>
                      ) : state.content.output === "null" ? (
                        <p>
                          {state.selected.status === "running"
                            ? "等待模型响应"
                            : "未记录响应"}
                        </p>
                      ) : (
                        <pre>{state.content.output}</pre>
                      )}
                    </details>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
