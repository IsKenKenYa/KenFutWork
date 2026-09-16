"use client";

import type { CompatReport } from "@kenfutwork/shared";
import { AlertTriangle, CheckCircle2, ShieldX } from "lucide-react";

/**
 * 兼容性报告展示：门禁结论 + 每条判定与理由。
 * 这里是「为什么不能装」的唯一出口——门禁的每条 issue 都要能被人读懂。
 */
export function CompatReportView({ report }: { report: CompatReport }) {
  const blockers = report.issues.filter((item) => item.severity === "blocker");
  const warnings = report.issues.filter((item) => item.severity === "warning");

  return (
    <div
      className="rounded-lg border p-3 text-xs"
      data-testid="compat-report"
      data-compatible={report.compatible}
    >
      <div className="flex items-center gap-2">
        {report.compatible ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <ShieldX className="h-3.5 w-3.5 text-destructive" />
        )}
        <span className="font-medium">
          {report.compatible
            ? "兼容性校验通过"
            : "兼容性校验未通过，已阻止安装"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {report.format} · {report.name}@{report.version}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {report.supportedCapabilities.map((capability) => (
          <span
            key={`ok-${capability}`}
            className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700"
          >
            支持 {capability}
          </span>
        ))}
        {report.unsupportedCapabilities.map((capability) => (
          <span
            key={`no-${capability}`}
            className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive"
          >
            缺少 {capability}
          </span>
        ))}
      </div>

      {blockers.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {blockers.map((item, index) => (
            <li key={`b-${item.code}-${index}`} className="flex gap-2">
              <ShieldX className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
              <div>
                <p>{item.message}</p>
                {item.detail ? (
                  <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                    {item.detail}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {warnings.map((item, index) => (
            <li key={`w-${item.code}-${index}`} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
              <div>
                <p>{item.message}</p>
                {item.detail ? (
                  <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                    {item.detail}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 报告里是否含安装期脚本判定（决定是否展示「授权」勾选）。 */
export function hasLifecycleIssue(report: CompatReport): boolean {
  return report.issues.some((item) => item.code === "lifecycle_script_present");
}
