const accessLostMessage = "本机连接已失效，请从桌面重新打开。";

export class ApiAccessError extends Error {
  constructor(message = accessLostMessage) {
    super(message);
    this.name = "ApiAccessError";
  }
}

export class ApiApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiApplicationError";
  }
}

const messagesByStatus: Partial<Record<number, string>> = {
  400: "请求格式有误，请检查填写内容。",
  401: accessLostMessage,
  403: "当前连接没有权限，请检查访问设置。",
  404: "找不到请求的内容，请刷新列表后查看。",
  409: "当前状态不允许此操作，请刷新后确认。",
  413: "提交内容太大，请减少文件大小后重试。",
  422: "服务未接受这些内容，请检查填写内容。",
  429: "请求过于频繁，请稍后再试。",
  503: "本机服务暂不可用，请确认 KenFutWork 正在运行。",
};

export async function readPublicHttpError(response: Response) {
  const payload: unknown = await response.json().catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  });
  const error =
    payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : null;
  // 兼容仍返回旧格式的服务。顶层框架消息和 HTML 不适合直接展示。
  const data = error && typeof error === "object" ? error : {};
  const code =
    "code" in data && typeof data.code === "string" ? data.code.trim() : "";
  const message =
    "message" in data && typeof data.message === "string"
      ? data.message.trim()
      : "";
  return {
    code: code || "application_error",
    message:
      message ||
      messagesByStatus[response.status] ||
      "本机服务未能完成请求，请检查工作台状态。",
  };
}

export async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) throw new ApiAccessError();
  const { code, message } = await readPublicHttpError(response);
  throw new ApiApplicationError(code, message);
}
