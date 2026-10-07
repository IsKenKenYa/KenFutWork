"use client";

import { instanceDataLocationResponseSchema } from "@kenfutwork/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isDesktopShell } from "@/lib/desktop-embed";
import {
  moveDataDirectory,
  openDataDirectory,
  openInBrowser,
} from "@/lib/desktop-system";
import { getServerBaseUrl } from "@/lib/env";
import { serverFetch } from "@/lib/local-access";
import { useLocalInstance } from "@/lib/local-instance-context";

export function LocalInstanceSection() {
  const { instance } = useLocalInstance();
  const [dataDir, setDataDir] = useState(instance?.dataDir ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [canMove, setCanMove] = useState(false);
  const [locationLoaded, setLocationLoaded] = useState(false);
  const desktop = isDesktopShell();
  useEffect(() => {
    let active = true;
    void serverFetch(`${getServerBaseUrl()}/api/instance/data-location`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(payload?.error?.message ?? "数据目录信息读取失败。");
        const location = instanceDataLocationResponseSchema.parse(payload);
        if (active) {
          setDataDir(location.dataDir);
          setCanMove(location.canMove);
          setLocationLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active)
          setNotice(
            error instanceof Error ? error.message : "数据目录信息读取失败。",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  const request = async (action: "open" | "move" | "browser") => {
    setBusy(true);
    setNotice(null);
    try {
      if (action === "open") await openDataDirectory();
      if (action === "browser") await openInBrowser();
      if (action === "move") {
        setNotice(
          "正在等待在途任务结束并迁移数据。完成后桌面应用会重新连接；外部代码目录保持原位置。",
        );
        await moveDataDirectory(dataDir.trim());
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "本机操作失败。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="本地实例设置" className="space-y-4">
      <div>
        <h3 className="text-base font-medium">本地实例</h3>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {instance?.instanceId}
        </p>
      </div>
      <div className="space-y-2">
        <label
          htmlFor="instance-data-directory"
          className="text-sm font-medium"
        >
          数据目录
        </label>
        <input
          id="instance-data-directory"
          readOnly={!desktop || !canMove}
          value={dataDir}
          onChange={(event) => setDataDir(event.target.value)}
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
        />
        {desktop ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void request("open")}
            >
              打开目录
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                !canMove ||
                !dataDir.trim() ||
                dataDir.trim() === instance?.dataDir
              }
              onClick={() => void request("move")}
            >
              迁移并重启
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void request("browser")}
            >
              在浏览器打开
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            请在桌面应用中迁移或打开目录
          </p>
        )}
        {desktop && locationLoaded && !canMove ? (
          <p className="text-sm text-muted-foreground">
            非桌面托管服务 · 无法迁移目录
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          迁移前等待任务结束
          <br />停机复制并校验后重启
          <br />失败保留原目录 · 项目代码目录不移动
        </p>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">备份与恢复</h4>
        <p className="text-sm text-muted-foreground">
          停机后复制完整数据目录
          <br />使用完整备份目录恢复
          <br />供应商 Key 以明文保存 · 妥善保管备份
        </p>
        <p className="text-sm text-muted-foreground">
          项目与会话保留
          <br />外部目录缺失需重新关联
          <br />已有任务不自动重放
        </p>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
