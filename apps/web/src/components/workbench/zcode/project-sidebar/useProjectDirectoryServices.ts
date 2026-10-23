import type { IProjectService } from "@zcode/services";
import { useMemo } from "react";

/** 目录查询使用项目服务，不借用当前 Task 的文件作用域。 */
export function useProjectDirectoryServices(service: IProjectService) {
  return useMemo(
    () => ({
      services: {
        systemService: {
          info: async () => ({
            homedir: (await service.readDirectory({ hostId: "local" })).path,
          }),
        },
        fileService: {
          readdir: async (params: { path: string; includeHidden?: boolean }) =>
            (await service.readDirectory({ ...params, hostId: "local" })).entries,
        },
      },
    }),
    [service],
  );
}
