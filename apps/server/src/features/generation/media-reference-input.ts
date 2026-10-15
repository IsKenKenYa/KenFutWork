/** 已解析输入仍需完整保留；一个引用无效就拒绝，不能静默丢参考图。 */
export function mediaReferenceInput(
  references: string[],
  mediaType: "image" | "video",
  attachmentMap?: Record<string, string>,
): string[] {
  return references.map((reference) => {
    const value = attachmentMap?.[reference] ?? reference;
    if (value.startsWith(`data:${mediaType}/`) && value.includes(";base64,"))
      return value;
    if (/^https?:\/\//u.test(value)) {
      const url = new URL(value);
      if (
        !["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(
          url.hostname,
        ) &&
        !url.hostname.endsWith(".localhost")
      )
        return value;
    }
    throw new Error("参考素材无法读取，请重新选择或使用素材标识。 ");
  });
}
