import {
  createContextSettings,
  DICT_ZH,
  makeContextBrowser,
  makeLegend,
  makeRequestDetail,
  makeStackedBar,
  makeTrendChart,
  makeViewKit,
} from "@kenfutwork/context-insights-ui";
import { useState } from "react";
import type { buildContextTimeline } from "./contextInspectionModel.js";

const dictionary: Record<string, string> = {
  ...DICT_ZH,
  "browser.live": "最近已读取",
  "browser.stepAt": "请求 #{s}",
  "browser.pickStep": "请求 #{s}",
  "detail.step": "请求 #{s}",
  "tip.step": "请求 #{s}",
  "browser.stepAtTip": "首次出现在请求 #{s}",
};
const kit = makeViewKit((key, params) => {
  let value = dictionary[key] ?? key;
  for (const [name, text] of Object.entries(params ?? {}))
    value = value.replaceAll(`{${name}}`, String(text));
  return value;
});
const StackedBar = makeStackedBar(kit);
const Legend = makeLegend(kit);
const Browser = makeContextBrowser(kit, StackedBar, createContextSettings());
const RequestDetail = makeRequestDetail(kit, StackedBar, Legend);
const TrendChart = makeTrendChart(kit);
const noop = () => {};

export function ContextInspectionViews({
  data,
  requestId,
  onSelect,
}: {
  data: ReturnType<typeof buildContextTimeline>;
  requestId: string;
  onSelect: (id: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [delta, setDelta] = useState(false);
  const seq = data.seqByRequest.get(requestId) ?? null;
  const request = data.timeline.requests.find((r) => r.seq === seq) ?? null;
  return (
    <>
      <div className="lc-card">
        <h2>已读取请求趋势</h2>
        <span className="context-inspection-note">
          同一 Run 与 Agent · 组成估算
        </span>
        <button
          type="button"
          aria-pressed={delta}
          onClick={() => setDelta(!delta)}
        >
          变化量
        </button>
        <TrendChart
          requests={data.timeline.requests}
          markers={[]}
          selectedSeq={seq}
          hoveredSeq={hover}
          activeTurn={null}
          granularity="step"
          mode={delta ? "delta" : "total"}
          focusTurn={null}
          focusSeq={null}
          hoverCat={null}
          onSelect={(value) => {
            const id = value === null ? null : data.idBySeq.get(value);
            if (id) onSelect(id);
          }}
          onHover={setHover}
          onHoverTurn={noop}
          onPickTurn={noop}
          onFocusTurnHandled={noop}
          onFocusSeqHandled={noop}
        />
        <details>
          <summary>查看趋势数据</summary>
          <table>
            <caption>请求上下文</caption>
            <thead>
              <tr>
                <th scope="col">请求</th>
                <th scope="col">组成估算</th>
                <th scope="col">实际输入</th>
                <th scope="col">实际输出</th>
              </tr>
            </thead>
            <tbody>
              {data.timeline.requests.map((r) => (
                <tr key={r.seq}>
                  <td>{r.step}</td>
                  <td>{r.total}</td>
                  <td>{r.prompt ?? "未知"}</td>
                  <td>{r.output ?? "未知"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
      <RequestDetail request={request} />
      <Browser
        key={requestId}
        session={requestId}
        locale="zh-CN"
        data={data.timeline}
        headers={data.headers}
        convNodes={data.convNodes}
        pinSeq={seq}
        fetchHeader={async (value) => data.headerContent.get(value) ?? null}
      />
    </>
  );
}
