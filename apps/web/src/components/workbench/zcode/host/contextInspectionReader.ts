import { contextRequestPageSchema } from "@kenfutwork/shared";

export type InspectionCall = (
  method: string,
  args?: unknown[],
) => Promise<unknown>;

/** 按服务端读取预算组合正文；取消后不再发送后续读取。 */
export async function readContextPart(
  call: InspectionCall,
  taskId: string,
  requestId: string,
  part: "input" | "output",
  signal: AbortSignal,
): Promise<string> {
  const chunks: string[] = [];
  let offset = 0;
  let total: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = contextRequestPageSchema.parse(
      await call("read", [{ taskId, requestId, part, offset }]),
    );
    signal.throwIfAborted();
    total ??= page.totalCharacters;
    if (page.totalCharacters !== total)
      throw new Error("请求记录已更新，请重新读取。");
    const end = offset + page.text.length;
    if (
      end > total ||
      (page.nextOffset !== null && page.nextOffset !== end) ||
      (page.nextOffset !== null && page.nextOffset <= offset) ||
      (page.nextOffset === null && end !== total)
    )
      throw new Error("请求分页不完整，请重新读取。");
    chunks.push(page.text);
    if (page.nextOffset === null) return chunks.join("");
    offset = page.nextOffset;
  }
}
