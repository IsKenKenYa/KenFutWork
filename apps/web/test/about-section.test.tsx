// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AboutSection } from "../src/components/workbench/about-section";

/**
 * 设置 → 关于。
 *
 * 排版口径（用户口径 2026-09-27「还是很啰嗦，而且排版很不合理」）：与其它设置页同一套行
 * （全宽、标签左值右），许可清单默认折叠——署名可查（法律要求）但首屏只有三行。
 *
 * 另锁一条**正确性**规则：产品名后面不许再标版本号。`/api/health` 的 version 是**服务端包**
 * 的版本（`env.version` 读 apps/server/package.json），标在产品名后等于把服务端版本说成
 * 客户端版本——自托管跑旧服务端时会直接说错，而且与下一行「服务端」重复同一个数字。
 */
function stubHealth(payload: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok
        ? new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("", { status: 500 }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("设置 → 关于", () => {
  it("三行身份信息：产品名 + 服务端 + 地址", async () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://127.0.0.1:3001");
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    render(<AboutSection />);

    expect(screen.getByText("KenFutWork")).toBeVisible();
    expect(screen.getByText("BYOK 的 AI 工作台")).toBeVisible();
    expect(await screen.findByText("kenfutwork-server · v1.2.3")).toBeVisible();
    expect(screen.getByText("地址")).toBeVisible();
    expect(screen.getByText("http://127.0.0.1:3001")).toBeVisible();
  });

  it("版本号只出现一次：不把服务端版本标到产品名后面", async () => {
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    const { container } = render(<AboutSection />);
    await screen.findByText("kenfutwork-server · v1.2.3");

    // 全页只有「服务端」那一行带版本号；产品名行不许再出现一次
    expect(container.textContent?.match(/v1\.2\.3/g)).toHaveLength(1);
  });

  it("服务端读不到时如实说「未连接」，不编造版本", async () => {
    stubHealth(null, false);
    const { container } = render(<AboutSection />);
    expect(await screen.findByText("未连接")).toBeVisible();
    expect(container.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  it("许可清单默认折叠在 <details> 里：署名可查但不占首屏", async () => {
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    render(<AboutSection />);

    const details = document.querySelector("details");
    expect(details).not.toBeNull();
    // 默认闭合：没有 open 属性
    expect(details?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("第三方模型许可")).toBeVisible();

    // 五项署名与「录音不留存」都在（折叠不等于删掉——许可是法律要求）
    for (const label of [
      "SenseVoiceSmall",
      "sherpa-onnx",
      "Silero VAD",
      "Kokoro 多语版",
      "espeak-ng 数据",
      "录音不留存",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("同源部署（base 为空串）显示「（同源）」而不是空白", async () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    render(<AboutSection />);
    expect(await screen.findByText("（同源）")).toBeVisible();
  });
});
