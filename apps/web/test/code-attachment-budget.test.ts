import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createChatComposerAttachment,
  serializeChatComposerAttachment,
} from "../src/components/workbench/zcode/lib/chatAttachments.js";
import { uploadComposerAttachment } from "../src/components/workbench/zcode/v4/composer/attachmentUpload.js";

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:test-attachment";
      }
      static revokeObjectURL() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it("附件命令面拒绝path-only旁路，有真实bytes才取得committed私有ref", async () => {
  const put = vi.fn(async () => ({ ref: "code-attachment:committed" }));
  const attachment = {
    kind: "file" as const,
    filename: "own.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 3,
    localPath: "/renderer-only/private-file",
  };
  await expect(
    uploadComposerAttachment(put, "same-task", attachment),
  ).rejects.toThrow("本地文件导入尚不可用");
  expect(put).not.toHaveBeenCalled();
  await expect(
    uploadComposerAttachment(put, "same-task", {
      ...attachment,
      dataBase64: "AAEC",
    }),
  ).resolves.toMatchObject({ ref: "code-attachment:committed", bytes: 3 });
  expect(put).toHaveBeenCalledWith(
    {
      sessionId: "same-task",
      fileName: "own.bin",
      mime: "application/octet-stream",
      dataBase64: "AAEC",
    },
    undefined,
  );
});

it("宿主收紧容量在读取File前拒绝，普通二进制保留真实bytes而非metadata-only", async () => {
  const file = new File([new Uint8Array([0, 255, 1, 2])], "four.bin", {
    type: "application/octet-stream",
  });
  const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
  const attachment = createChatComposerAttachment(file);
  await expect(
    serializeChatComposerAttachment(attachment, { maxBytes: 3 }),
  ).rejects.toThrow("预算");
  expect(read).not.toHaveBeenCalled();
  const serialized = await serializeChatComposerAttachment(attachment, {
    maxBytes: 4,
  });
  expect(serialized).toMatchObject({
    kind: "file",
    filename: "four.bin",
    sizeBytes: 4,
    dataBase64: "AP8BAg==",
  });
  read.mockRestore();
});

it("PDF高于旧20MiB但在当前宿主预算内仍能完整序列化", async () => {
  // Actual File bytes exercise the removed legacy cap; this is a test input, not a runtime limit.
  const bytes = 21 * 1024 * 1024;
  const file = new File([new Uint8Array(bytes)], "large.pdf", {
    type: "application/pdf",
  });
  const serialized = await serializeChatComposerAttachment(
    createChatComposerAttachment(file),
    { maxBytes: bytes },
  );
  expect(serialized.kind).toBe("pdf");
  expect("dataBase64" in serialized && serialized.dataBase64?.length).toBe(
    Math.ceil(bytes / 3) * 4,
  );
});

it.each([
  ["image", "own.png", "image/png"],
  ["video", "own.mp4", "video/mp4"],
  ["pdf", "own.pdf", "application/pdf"],
  ["file", "own.bin", "application/octet-stream"],
])(
  "%s的真实File有本地路径也只序列化bytes，路径不成为附件ref",
  async (kind, filename, mime) => {
    const file = new File([new Uint8Array([0, 1, 2])], filename, {
      type: mime,
    });
    const serialized = await serializeChatComposerAttachment(
      createChatComposerAttachment(file, "/renderer-only/private-file"),
      { maxBytes: 3 },
    );
    expect(serialized).toMatchObject({
      kind,
      dataBase64: "AAEC",
      sizeBytes: 3,
    });
    expect(serialized).not.toHaveProperty("localPath");
  },
);
