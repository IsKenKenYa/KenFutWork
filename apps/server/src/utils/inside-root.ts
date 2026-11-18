import { resolve, sep } from "node:path";

/**
 * 把「用户/模型给的相对路径」限制在一个根目录内（防 `../` 逃逸）。
 *
 * 抽到 utils：技能包读取（sandbox-skill-packages）与插件 bundle 安装
 * （plugins 的沙箱安装路径）都要做同一个判定——两处各写一份，早晚漂移成
 * 「一处拦得住、一处拦不住」。
 *
 * @returns 解析后的绝对路径
 * @throws Error 越界（调用方转 400）
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const rootAbsolute = resolve(root);
  const target = resolve(rootAbsolute, relativePath);
  if (target !== rootAbsolute && !target.startsWith(rootAbsolute + sep)) {
    throw new Error("路径越出工作目录。");
  }
  return target;
}
