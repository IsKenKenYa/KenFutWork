import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingScreen } from "../src/components/loading-screen";

/**
 * 用户口径（2026-10-19）：加载动画只留一种——黑色 logo、无底板、下方转圈。
 * 加载链路横跨两个构建世界（Next 应用层 / zcode 壳），无法共用同一份组件，
 * 因此这里用源码门禁锁死「形态一致 + 不再出现第二套动画」。
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) =>
  readFileSync(path.join(ROOT, "src", rel), "utf8");

/** 各自定义一份「logo + 转圈」的两个构建世界，加壳预渲染 HTML。 */
const DEFINING = {
  "web 加载屏": "components/loading-screen.tsx",
  "zcode 启动屏": "components/workbench/zcode/root/RootStartupLoading.tsx",
  "壳预渲染 HTML": "components/workbench/zcode/index.html",
} as const;

/** 复用定义点的加载屏，不得自带一份动画。 */
const REUSING = {
  "flow 内嵌帧": "components/workbench/zcode/host/FlowSurface.tsx",
  "OpenDesign 面": "components/workbench/zcode/host/OpenDesignPane.tsx",
  本机连接屏: "lib/local-instance-context.tsx",
} as const;

/** 第二套动画的指纹：浮动 logo、三点呼吸、黑色底板，一律不许再出现在加载路径上。 */
const FORBIDDEN = [
  "animate-logo-float",
  "animate-loading-dot",
  "logo-shell",
  "[animation-delay:",
];

describe("全站唯一加载动画", () => {
  it("加载路径源码不再包含第二套动画或 logo 底板", () => {
    for (const [name, rel] of Object.entries({ ...DEFINING, ...REUSING })) {
      const text = source(rel);
      for (const token of FORBIDDEN) {
        expect(text, `${name} 不应出现 ${token}`).not.toContain(token);
      }
    }
    expect(source("app/globals.css")).not.toContain("@keyframes logo-float");
    expect(source("app/globals.css")).not.toContain("@keyframes loading-dot");
  });

  it("定义点都带旋转圈，复用方都指向定义点", () => {
    for (const [name, rel] of Object.entries(DEFINING)) {
      expect(source(rel), `${name} 缺少旋转圈`).toMatch(
        /animate-spin|zcode-boot-spin/,
      );
    }
    for (const rel of [REUSING["flow 内嵌帧"], REUSING["OpenDesign 面"]]) {
      expect(source(rel), `${rel} 未复用壳层加载原子`).toContain(
        "ZCodeStartupSpinner",
      );
    }
    expect(source(REUSING["本机连接屏"])).toContain(
      'LoadingScreen } from "@/components/loading-screen',
    );
  });

  it("渲染出的加载屏是黑色 logo + 一个旋转圈，无底板", () => {
    const { container } = render(<LoadingScreen label="连接中" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("aria-label")).toBe("连接中");

    const logo = container.querySelector("img");
    expect(logo?.className).toContain("brightness-0");

    const animated = container.querySelectorAll('[class*="animate-"]');
    expect(animated).toHaveLength(1);
    expect(animated[0]?.className).toContain("animate-spin");
  });
});
