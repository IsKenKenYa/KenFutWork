import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { OpenDesignCommentComposer } from "../src/components/workbench/zcode/host/OpenDesignCommentSidebar.js";
import {
  type OpenDesignEditDraft,
  OpenDesignEditInspector,
} from "../src/components/workbench/zcode/host/OpenDesignEditInspector.js";
import type { OpenDesignHit } from "../src/components/workbench/zcode/host/openDesignRuntime.js";

afterEach(cleanup);

const hit: OpenDesignHit = {
  path: "#title",
  tag: "h1",
  text: "当前标题",
  html: '<h1 id="title">当前标题</h1>',
  rect: { x: 0, y: 0, w: 160, h: 32 },
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  fontSize: "32px",
  fontWeight: "700",
  textAlign: "left",
  padding: "0px",
  margin: "0px",
  borderRadius: "0px",
};

test("通过标签找到HTML输入框并提交修改内容", () => {
  let saved: OpenDesignEditDraft | undefined;
  render(
    <OpenDesignEditInspector
      hit={hit}
      busy={false}
      onCancel={cleanup}
      onSave={(draft) => {
        saved = draft;
      }}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "选中元素的 HTML" });
  expect(editor).toHaveProperty("value", hit.html);
  fireEvent.change(editor, { target: { value: "<h1>更新的标题</h1>" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(saved).toEqual({
    html: "<h1>更新的标题</h1>",
    color: "",
    backgroundColor: "",
    fontSize: "",
    fontWeight: "",
    textAlign: "",
    padding: "",
    margin: "",
    borderRadius: "",
  });
});

test("打开评论框不抢焦点，点击输入后可提交评论内容", () => {
  let submitted: string | undefined;
  render(
    <OpenDesignCommentComposer
      excerpt="当前标题"
      busy={false}
      onCancel={cleanup}
      onSubmit={(body) => {
        submitted = body;
      }}
    />,
  );
  const editor = screen.getByPlaceholderText("评论");
  expect(document.activeElement).not.toBe(editor);
  // jsdom 的 click 不派发焦点，用 focus() 表达用户点击输入框后的聚焦。
  editor.focus();
  expect(document.activeElement).toBe(editor);
  fireEvent.change(editor, { target: { value: "  标题颜色加深  " } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(submitted).toBe("标题颜色加深");
});
