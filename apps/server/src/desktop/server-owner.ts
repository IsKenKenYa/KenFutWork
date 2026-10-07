import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DesktopServerOwner {
  close(): void;
}

/** 操作系统文件锁覆盖同一实例的启动到停库；进程被强杀也自动释放，不靠陈旧PID猜属主。 */
export function acquireDesktopServerOwner(dataDir: string): DesktopServerOwner {
  const lock = new DatabaseSync(join(dataDir, ".server-owner.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    const failure = error as { code?: string; errcode?: number };
    if (
      failure.code === "ERR_SQLITE_ERROR" &&
      (failure.errcode === 5 || failure.errcode === 6)
    ) {
      throw Object.assign(
        new Error("本地实例已有服务进程正在启动或运行，不能重复接管数据库。"),
        {
          code: "desktop_instance_busy",
        },
      );
    }
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      lock.close();
    },
  };
}
