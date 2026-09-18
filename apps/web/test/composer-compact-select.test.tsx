// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComposerCompactSelect,
  optionLabel,
  showsThinkingProgress,
  THINKING_OPTIONS,
  THINKING_PROGRESS,
  TIER_OPTIONS,
  thinkingPromptHint,
  tierIcon,
} from "../src/components/workbench/composer-compact-select";

/**
 * composer 的图标下拉（用户口径：右侧面板拉大、对话列塞不下时，思考强度与权限改成图标）。
 *
 * 收起文字的判据走 **CSS 容器查询**（浏览器排版时算，不等 JS 事件），所以这里锁的是：
 * 文字节点带着「容器窄于 36rem 就隐藏」的变体类、title 始终交代当前值、下拉照常可选。
 */
describe("ComposerCompactSelect", () => {
  afterEach(cleanup);

  const icon = <span data-testid="control-icon" />;

  it("完整形态：显示当前值的文字，并给出控件名 + 当前值的 title", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        options={TIER_OPTIONS}
        value="full-access"
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByLabelText("权限档位");
    expect(trigger).toHaveTextContent("完全访问");
    expect(trigger).toHaveAttribute("title", "权限档位：完全访问");
    expect(within(trigger).getByTestId("control-icon")).toBeInTheDocument();
  });

  it("窄列收起文字：靠容器查询变体类，不靠 JS 量宽度", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        options={TIER_OPTIONS}
        value="default"
        onChange={() => {}}
      />,
    );
    // SelectValue 渲染出的值节点必须带 `@max-xl/composer:hidden`：
    // 少了它，面板拉宽挤窄对话列时文字不会收起（本轮用户反馈的原始问题）
    const value = screen
      .getByLabelText("权限档位")
      .querySelector('[data-slot="select-value"]');
    expect(value).not.toBeNull();
    expect(value?.className).toContain("@max-xl/composer:hidden");
  });

  it("下拉仍可选：选中后回调新值", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="default"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("思考强度"));
    await user.click(await screen.findByRole("option", { name: "高" }));
    expect(onChange).toHaveBeenCalledWith("高");
  });

  it("选中当前值不触发回调（不白跑一次设置写入）", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="中"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("思考强度"));
    await user.click(await screen.findByRole("option", { name: "中" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("值不在选项表里时 title 回落到原值（不吞掉显示）", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="自定义档"
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("思考强度")).toHaveAttribute(
      "title",
      "思考强度：自定义档",
    );
  });

  it("鼠标悬停显示说明面板：列出各档含义、高亮当前档（纯 CSS，不依赖事件）", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        options={TIER_OPTIONS}
        value="full-access"
        onChange={() => {}}
      />,
    );
    const panel = screen.getByRole("tooltip", { name: "权限档位说明" });
    // 面板靠 group-hover 显示（容器变窄时文字藏起来，得有个地方说明每一档是什么意思）；
    // **只在图标态（容器 < 36rem）出现**——宽列下文字都在，悬停再弹一个面板是多余的
    expect(panel.className).toContain("@max-xl/composer:group-hover:block");
    expect(panel.className).toContain("hidden");
    expect(panel).toHaveTextContent("当前：完全访问");
    expect(panel).toHaveTextContent("改文件 / 跑命令前先问我");
    expect(panel).toHaveTextContent("已批准的调用自动通过");
  });

  it("思考强度是「图标 + **竖条**」：档位越高条越满，且不再显示下拉箭头", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="最高"
        onChange={() => {}}
        progress={1}
      />,
    );
    const trigger = screen.getByLabelText("思考强度");
    // 竖条：外层是纵向 flex 的轨道，填充按**高度**百分比（用户口径：思考强度改成竖着的）
    const track = [...trigger.querySelectorAll("span")].find((el) =>
      (el.getAttribute("class") ?? "").includes("flex-col"),
    );
    expect(track?.className).toContain("h-3.5");
    expect(track?.className).toContain("w-1");
    const fill = [...(track?.querySelectorAll("span") ?? [])].find((el) =>
      /height:/.test(el.getAttribute("style") ?? ""),
    );
    expect(fill?.getAttribute("style")).toContain("100%");
    // 填充是绿色（参考图里就是绿的）
    expect(fill?.getAttribute("class")).toContain("bg-emerald-600");
    // 除模型外一律不给下拉箭头（用户口径：自主/权限/思考强度的箭头都去掉）
    expect(trigger.querySelector("svg.lucide-chevron-down")).toBeNull();
  });
});

/**
 * 权限四档在编排器里要齐（第四档「自定义」是后加的，曾经漏在这一处：
 * 结果编排器显示原始值 `custom`、下拉里也选不到它）。
 *
 * 档名与图标都是用户口径：「描述也改一下：默认、自动审批、完全访问、自定义」
 * 「图标可以参考一下，不要全部都一样」。
 */
describe("权限档位选项", () => {
  it("四档齐全，档名就是那四个词", () => {
    expect(TIER_OPTIONS.map((option) => option.value)).toEqual([
      "default",
      "auto-approve",
      "full-access",
      "custom",
    ]);
    expect(TIER_OPTIONS.map((option) => option.label)).toEqual([
      "默认",
      "自动审批",
      "完全访问",
      "自定义",
    ]);
  });

  it("按值查中文名：custom → 自定义（不再回落成原始值）", () => {
    expect(optionLabel(TIER_OPTIONS, "custom")).toBe("自定义");
  });

  it("每档一个图标、四个都不一样（别退回一个通用盾牌）", () => {
    const shapes = TIER_OPTIONS.map((option) => {
      const { container, unmount } = render(
        <ComposerCompactSelect
          ariaLabel="权限档位"
          icon={tierIcon(option.value)}
          options={TIER_OPTIONS}
          value={option.value}
          onChange={() => {}}
        />,
      );
      const markup = container.querySelector("svg")?.innerHTML ?? "";
      unmount();
      return markup;
    });
    expect(shapes.every((markup) => markup.length > 0)).toBe(true);
    expect(new Set(shapes).size).toBe(TIER_OPTIONS.length);
  });

  it("触发器图标随当前档位变（不是写死一个）", () => {
    const shapeFor = (value: string) => {
      const { container, unmount } = render(
        <ComposerCompactSelect
          ariaLabel="权限档位"
          icon={tierIcon(value)}
          options={TIER_OPTIONS}
          value={value}
          onChange={() => {}}
        />,
      );
      const markup = container.querySelector("svg")?.innerHTML ?? "";
      unmount();
      return markup;
    };
    expect(shapeFor("default")).not.toBe(shapeFor("full-access"));
  });
});

/**
 * 「默认」档不显示进度（用户口径）：只留一根空的浅灰轨道；选了档位才填。
 */
describe("思考强度：默认态不显示进度", () => {
  afterEach(cleanup);

  const renderWith = (value: string) =>
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={<span data-testid="brain-icon" />}
        options={THINKING_OPTIONS}
        value={value}
        onChange={() => {}}
        progress={THINKING_PROGRESS[value] ?? 0}
      />,
    );

  it("默认：轨道在、填充不在", () => {
    renderWith("默认");
    const trigger = screen.getByLabelText("思考强度");
    const track = [...trigger.querySelectorAll("span")].find((el) =>
      (el.getAttribute("class") ?? "").includes("flex-col"),
    );
    expect(track).toBeTruthy();
    expect(track?.querySelector("span")).toBeNull();
  });

  it("低：有填充且为绿色（25%）", () => {
    renderWith("低");
    const trigger = screen.getByLabelText("思考强度");
    const track = [...trigger.querySelectorAll("span")].find((el) =>
      (el.getAttribute("class") ?? "").includes("flex-col"),
    );
    const fill = track?.querySelector("span");
    expect(fill?.getAttribute("style")).toContain("25%");
    expect(fill?.getAttribute("class")).toContain("bg-emerald-600");
  });
});

/**
 * 「关闭」档（用户口径：加一个思考强度关闭，用现在的进度条样式——也就是 0%）。
 *
 * 它是**有执行面的**档位：提示词里说清「不要展开推理，直接给结论」，
 * 而不是只多一个看不懂的选项。
 */
describe("思考强度：关闭档", () => {
  afterEach(cleanup);

  it("选项表里有「关闭」，且它是 0%（默认不画条、关闭才画 0% 的条）", () => {
    expect(THINKING_OPTIONS.map((option) => option.value)).toEqual([
      "default",
      "关闭",
      "低",
      "中",
      "高",
      "最高",
    ]);
    expect(THINKING_PROGRESS.关闭).toBe(0);
    // 注意：`默认` 是**文本**，值是 `default`
    expect(showsThinkingProgress("default")).toBe(false);
    expect(showsThinkingProgress("关闭")).toBe(true);
  });

  it("选了「关闭」：轨道在、填充是 0%（用现在的进度条样式）", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={<span data-testid="brain-icon" />}
        options={THINKING_OPTIONS}
        value="关闭"
        onChange={() => {}}
        progress={THINKING_PROGRESS.关闭 ?? 0}
      />,
    );
    const trigger = screen.getByLabelText("思考强度");
    const track = [...trigger.querySelectorAll("span")].find((el) =>
      (el.getAttribute("class") ?? "").includes("flex-col"),
    );
    expect(track).toBeTruthy();
    // 0% → 没有填充（0 高度画不出来），但轨道要留着（区别于「默认」：那边连轨道都不画）
    expect(track?.querySelector("span")).toBeNull();
    // 触发器上是「关闭」这个当前值（下拉没打开时只有这一处）
    expect(screen.getByLabelText("思考强度").textContent).toContain("关闭");
  });

  it("提示词：关闭说清「不要展开推理」；默认不注入；档位照旧", () => {
    expect(thinkingPromptHint("default")).toBe("");
    expect(thinkingPromptHint("关闭")).toContain("不要展开推理过程");
    expect(thinkingPromptHint("关闭")).toContain("直接给结论");
    expect(thinkingPromptHint("最高")).toBe("【思考强度：最高】\n");
  });
});
