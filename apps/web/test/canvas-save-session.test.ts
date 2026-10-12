import type { CanvasContent, CanvasSaveResponse } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createCanvasSaveSession,
  initialCanvasFileReferences,
} from "@/lib/canvas-save-session";

const content: CanvasContent = {
  elements: [],
  appState: {},
  files: {
    existing: {
      id: "existing",
      mimeType: "image/png",
      created: 1,
      dataURL: "data:image/png;base64,existing-bytes",
    },
    added: {
      id: "added",
      mimeType: "image/png",
      created: 2,
      dataURL: "data:image/png;base64,new-bytes",
    },
  },
};

describe("canvas save session", () => {
  it("serializes saves with the latest revision and stops resending uploaded file bytes", async () => {
    const session = createCanvasSaveSession({
      revision: "revision-1",
      fileReferences: { existing: "opaque://existing" },
    });
    const calls: Array<{
      content: CanvasContent;
      revision: string | null;
    }> = [];
    let finishFirst: ((result: CanvasSaveResponse) => void) | undefined;
    const firstResponse = new Promise<CanvasSaveResponse>((resolve) => {
      finishFirst = resolve;
    });
    const send = async (
      savedContent: CanvasContent,
      revision: string | null,
    ): Promise<CanvasSaveResponse> => {
      calls.push({ content: savedContent, revision });
      if (calls.length === 1) return firstResponse;
      return {
        ok: true,
        revision: "revision-3",
        fileReferences: {},
      };
    };

    const first = session.save(content, send);
    const second = session.save(content, send);
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.revision).toBe("revision-1");
    expect(calls[0]?.content.files.existing).toMatchObject({
      storageRef: "opaque://existing",
    });
    expect(calls[0]?.content.files.existing).not.toHaveProperty("dataURL");
    expect(calls[0]?.content.files.added).toHaveProperty(
      "dataURL",
      "data:image/png;base64,new-bytes",
    );
    if (!finishFirst) throw new Error("first save did not start");
    finishFirst({
      ok: true,
      revision: "revision-2",
      fileReferences: { added: "project-file://added" },
    });
    await Promise.all([first, second]);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.revision).toBe("revision-2");
    expect(calls[1]?.content.files.added).toMatchObject({
      storageRef: "project-file://added",
    });
    expect(calls[1]?.content.files.added).not.toHaveProperty("dataURL");
    expect(session.revision).toBe("revision-3");
  });

  it("seeds stable refs from GET content", () => {
    expect(
      initialCanvasFileReferences({
        existing: {
          storageRef: "oss://stable-reference",
          storageUrl: "https://signed",
        },
        inline: { dataURL: "data:image/png;base64,bytes" },
      }),
    ).toEqual({ existing: "oss://stable-reference" });
  });

  it("accepts a remote snapshot only while idle and replaces revision and file state", async () => {
    const session = createCanvasSaveSession({
      revision: "revision-1",
      fileReferences: {},
      files: content.files,
    });
    const snapshot = {
      revision: "revision-2",
      fileReferences: { image: "oss://image" },
      files: { image: { storageRef: "oss://image" } },
    };
    expect(session.acceptRemoteSnapshot(snapshot)).toBe(true);
    expect(session.revision).toBe("revision-2");
    expect(session.fileReferences).toEqual({ image: "oss://image" });

    let finish: ((value: CanvasSaveResponse) => void) | undefined;
    const pending = new Promise<CanvasSaveResponse>((resolve) => {
      finish = resolve;
    });
    const save = session.save(content, () => pending);
    expect(session.acceptRemoteSnapshot(snapshot)).toBe(false);
    if (!finish) throw new Error("save did not start");
    finish({ ok: true, revision: "revision-3", fileReferences: {} });
    await save;
  });

  it("preserves known files omitted during incomplete hydration", async () => {
    const session = createCanvasSaveSession({
      revision: "revision-1",
      fileReferences: { existing: "oss://stable" },
      files: { existing: { id: "existing", mimeType: "image/png" } },
    });
    const send = vi.fn(async (_content: CanvasContent) => ({
      ok: true as const,
      revision: "revision-2",
      fileReferences: {},
    }));
    await session.save({ ...content, files: {} }, send);
    expect(send.mock.calls[0]?.[0]?.files.existing).toMatchObject({
      id: "existing",
      storageRef: "oss://stable",
    });
  });

  it("latches a revision conflict and does not send queued or later saves", async () => {
    const session = createCanvasSaveSession({
      revision: "revision-1",
      fileReferences: {},
    });
    const conflict = Object.assign(
      new Error("画布已改变，请重新加载后保存。"),
      {
        code: "canvas_revision_conflict",
      },
    );
    const send = vi.fn(async () => {
      throw conflict;
    });
    const onConflict = vi.fn();

    const first = session.save(content, send, onConflict);
    const queued = session.save(content, send, onConflict);
    await expect(first).rejects.toBe(conflict);
    await expect(queued).rejects.toBe(conflict);
    await expect(session.save(content, send, onConflict)).rejects.toBe(
      conflict,
    );
    session.saveKeepalive(content, send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(session.revision).toBe("revision-1");
  });

  it("keepalive sends immediately with the current revision and stable refs", async () => {
    const session = createCanvasSaveSession({
      revision: "revision-1",
      fileReferences: {},
    });
    const send = vi.fn(
      async (_content: CanvasContent, revision: string | null) => ({
        ok: true as const,
        revision: revision === "revision-1" ? "revision-2" : "revision-3",
        fileReferences: {},
      }),
    );

    await session.save(content, send);
    session.saveKeepalive(content, send);
    await Promise.resolve();

    expect(send).toHaveBeenNthCalledWith(1, expect.any(Object), "revision-1");
    expect(send).toHaveBeenNthCalledWith(2, expect.any(Object), "revision-2");
    expect(send.mock.calls[1]?.[0].files.added).toHaveProperty("dataURL");
  });

  it("keepalive racing an in-flight save uses the same compare-and-swap revision", async () => {
    const session = createCanvasSaveSession({
      revision: "revision-1",
      fileReferences: {},
    });
    const calls: Array<string | null> = [];
    let finishSave: ((result: CanvasSaveResponse) => void) | undefined;
    const inFlight = new Promise<CanvasSaveResponse>((resolve) => {
      finishSave = resolve;
    });
    const send = async (
      _content: CanvasContent,
      revision: string | null,
    ): Promise<CanvasSaveResponse> => {
      calls.push(revision);
      if (calls.length === 1) return inFlight;
      return {
        ok: true,
        revision: "revision-2",
        fileReferences: {},
      };
    };

    const regularSave = session.save(content, send);
    await Promise.resolve();
    session.saveKeepalive(content, send);
    await Promise.resolve();

    expect(calls).toEqual(["revision-1", "revision-1"]);
    if (!finishSave) throw new Error("regular save did not start");
    finishSave({
      ok: true,
      revision: "revision-2",
      fileReferences: {},
    });
    await regularSave;
  });
});
