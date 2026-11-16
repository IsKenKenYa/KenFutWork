import { ApiApplicationError } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { contextInspectionErrorMessage } from "../src/components/workbench/zcode/host/contextInspectionReader.js";

const readError = "上下文读取失败，请重新读取。";

it("保留公开错误的具体处理建议", () => {
  const error = new ApiApplicationError(
    "code_ui_not_found",
    "请求记录已不可用，请重新选择任务。",
    404,
  );
  expect(contextInspectionErrorMessage(error, readError)).toBe(error.message);
});

it.each([
  new Error("数据库内部原因"),
  { code: "code_ui_not_found", status: 404, message: "内部原因" },
  "内部原因",
  null,
  new DOMException("已取消", "AbortError"),
  new ApiApplicationError("application_error", " ", 500),
])("本地异常不作为公开原因展示：%s", (error) => {
  expect(contextInspectionErrorMessage(error, readError)).toBe(readError);
});
