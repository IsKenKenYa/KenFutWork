import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import {
  createScopedBackend,
  revokeTaskFileOperations,
  type ScopedFilesystemScope,
} from "./scoped-filesystem.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  agentId = "main",
  role: ScopedFilesystemScope["role"] = "main",
) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "code-files-"));
  directories.push(rootDirectory);
  const scope: ScopedFilesystemScope = {
    agentId,
    role,
    describe: () => ({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 0,
      rootDirectory,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    }),
    resolvePath: async (path, operation) => {
      if (operation === "write" && (role === "explore" || role === "review"))
        throw new Error("只读角色禁止写入");
      const absolute = resolve(rootDirectory, path);
      if (
        absolute !== rootDirectory &&
        !absolute.startsWith(`${rootDirectory}/`)
      )
        throw new Error("目录未授权");
      return absolute;
    },
  };
  return { rootDirectory, scope, backend: createScopedBackend(scope) };
}

function makePdf(contents: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data);
}

it("existing files require this agent to observe the current version before a write", async () => {
  const { backend, rootDirectory } = await fixture();
  await writeFile(join(rootDirectory, "note.txt"), "first\n");
  await expect(
    backend.writeFile({ path: "note.txt", content: "second\n" }),
  ).rejects.toThrow(/read|读取/i);
  const page = await backend.readPage({ path: "note.txt" });
  const written = await backend.writeFile({
    path: "note.txt",
    content: "second\n",
    expectedVersion: page.version,
  });
  expect(written).toMatchObject({
    type: "update",
    originalFile: "first\n",
    content: "second\n",
  });
  expect(written.structuredPatch[0]?.lines).toEqual(["-first", "+second"]);
  expect((await backend.readPage({ path: "note.txt" })).content).toBe(
    "second\n",
  );
});

it("partial reads permit exact edits inside that range but cannot authorize a whole-file replacement", async () => {
  const { backend, rootDirectory, scope } = await fixture();
  await writeFile(join(rootDirectory, "note.txt"), "one\nhidden\n");
  const page = await backend.readPage({ path: "note.txt", limit: 1 });
  await expect(
    backend.editFile({
      path: "note.txt",
      oldString: "hidden",
      newString: "lost",
    }),
  ).rejects.toThrow(/read|读取/i);
  const edited = await backend.editFile({
    path: "note.txt",
    oldString: "one",
    newString: "ONE",
  });
  expect(edited).toMatchObject({
    oldString: "one",
    newString: "ONE",
    occurrences: 1,
    content: "ONE\nhidden\n",
  });
  await expect(
    backend.writeFile({ path: "note.txt", content: "lost" }),
  ).rejects.toThrow(/完整读取/);
  const other = createScopedBackend({ ...scope, agentId: "other" });
  await expect(
    other.writeFile({
      path: "note.txt",
      content: "lost",
      expectedVersion: page.version,
    }),
  ).rejects.toThrow(/完整读取/);
  expect((await backend.readPage({ path: "note.txt" })).content).toBe(
    "ONE\nhidden\n",
  );
});

it("Unicode column cursors can continue and rewind, and reading every page authorizes a full write", async () => {
  const { rootDirectory, scope, backend: initial } = await fixture();
  await writeFile(join(rootDirectory, "unicode.txt"), "😀abc\nnext\n");
  const backend = createScopedBackend(scope, {
    limits: { ...initial.limits, codeReadPageCharacters: 2 },
  });
  const first = await backend.readPage({ path: "unicode.txt" });
  expect(first.content).toBe("😀a");
  expect(first.continuation).toMatchObject({
    line: 1,
    column: 3,
    version: first.version,
  });
  await expect(
    backend.readPage({ path: "unicode.txt", column: 1 }),
  ).rejects.toThrow(/Unicode/);
  expect((await backend.readPage({ path: "unicode.txt" })).content).toBe("😀a");
  let page = first;
  let content = page.content;
  while (page.continuation) {
    page = await backend.readPage({
      path: "unicode.txt",
      continuation: page.continuation,
    });
    content += page.content;
  }
  expect(content).toBe("😀abc\nnext\n");
  await backend.writeFile({ path: "unicode.txt", content: "updated\n" });
  if (!first.continuation) throw new Error("缺少Unicode继续指针");
  await expect(
    backend.readPage({
      path: "unicode.txt",
      continuation: first.continuation,
    }),
  ).rejects.toThrow(/版本/);
});

it("a late write cannot resurrect a deleted file, and concurrent agents cannot overwrite each other's commit", async () => {
  const { backend, rootDirectory, scope } = await fixture();
  await writeFile(join(rootDirectory, "shared.txt"), "original\n");
  const page = await backend.readPage({ path: "shared.txt" });
  await rm(join(rootDirectory, "shared.txt"));
  await expect(
    backend.writeFile({
      path: "shared.txt",
      content: "late\n",
      expectedVersion: page.version,
    }),
  ).rejects.toThrow(/变化|删除/);
  await backend.writeFile({
    path: "shared.txt",
    content: "fresh\n",
    createOnly: true,
  });
  const other = createScopedBackend({
    ...scope,
    agentId: "other-task",
    describe: () => ({
      ...scope.describe(),
      taskId: "00000000-0000-4000-8000-000000000004",
    }),
  });
  await Promise.all([
    backend.readPage({ path: "shared.txt" }),
    other.readPage({ path: "shared.txt" }),
  ]);
  const outcomes = await Promise.allSettled([
    backend.writeFile({ path: "shared.txt", content: "first\n" }),
    other.writeFile({ path: "shared.txt", content: "second\n" }),
  ]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(["first\n", "second\n"]).toContain(
    (await backend.readPage({ path: "shared.txt" })).content,
  );
});

it.each(["explore", "review"] as const)(
  "%s role cannot create files even with another agent's version",
  async (role) => {
    const { rootDirectory, scope } = await fixture("reader", role);
    await writeFile(join(rootDirectory, "readonly.txt"), "safe\n");
    const backend = createScopedBackend(scope);
    const page = await backend.readPage({ path: "readonly.txt" });
    await expect(
      backend.writeFile({
        path: "readonly.txt",
        content: "unsafe",
        expectedVersion: page.version,
      }),
    ).rejects.toThrow(/只读/);
    await expect(
      backend.editFile({ path: "new.txt", oldString: "", newString: "unsafe" }),
    ).rejects.toThrow(/只读/);
  },
);

it("patches use the same observed-version guard and report files already committed before a later failure", async () => {
  const { backend, rootDirectory } = await fixture();
  await writeFile(join(rootDirectory, "first.txt"), "before\n");
  await writeFile(join(rootDirectory, "second.txt"), "before\n");
  await backend.readPage({ path: "first.txt" });
  const result = await backend.applyPatch({
    patchText:
      "*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** Update File: second.txt\n@@\n-before\n+after\n*** End Patch",
  });
  expect(result.files).toMatchObject([
    {
      type: "update",
      filePath: join(rootDirectory, "first.txt"),
      additions: 1,
      deletions: 1,
    },
  ]);
  expect(result.failures).toMatchObject([{ filePath: "second.txt" }]);
  expect(result.failures[0]?.error).toMatch(/读取/);
  expect((await backend.readPage({ path: "first.txt" })).content).toBe(
    "after\n",
  );
  expect((await backend.readPage({ path: "second.txt" })).content).toBe(
    "before\n",
  );
});

it("opposite file moves use an ordered lock set and reject existing destinations without hanging", async () => {
  const { backend, rootDirectory, scope } = await fixture();
  await writeFile(join(rootDirectory, "a.txt"), "original\n");
  await writeFile(join(rootDirectory, "b.txt"), "original\n");
  const other = createScopedBackend({ ...scope, agentId: "other" });
  await Promise.all([
    backend.readPage({ path: "a.txt" }),
    other.readPage({ path: "b.txt" }),
  ]);
  const [first, second] = await Promise.all([
    backend.applyPatch({
      patchText:
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-original\n+updated\n*** End Patch",
    }),
    other.applyPatch({
      patchText:
        "*** Begin Patch\n*** Update File: b.txt\n*** Move to: a.txt\n@@\n-original\n+updated\n*** End Patch",
    }),
  ]);
  expect(first.failures[0]?.error).toMatch(/覆盖/);
  expect(second.failures[0]?.error).toMatch(/覆盖/);
  expect((await backend.readPage({ path: "a.txt" })).content).toBe(
    "original\n",
  );
}, 1_000);

it("the same tool call replays one committed edit and rejects a conflicting parameter fingerprint", async () => {
  const { backend, rootDirectory } = await fixture();
  await writeFile(join(rootDirectory, "replay.txt"), "before\n");
  await backend.readPage({ path: "replay.txt" });
  const input = {
    path: "replay.txt",
    oldString: "before",
    newString: "after",
    operationId: "stable-tool-call",
  };
  const [first, replay] = await Promise.all([
    backend.editFile(input),
    backend.editFile(input),
  ]);
  expect(replay.version).toBe(first.version);
  expect((await backend.editFile(input)).version).toBe(first.version);
  await expect(
    backend.editFile({ ...input, newString: "conflict" }),
  ).rejects.toThrow(/参数|fingerprint/i);
  expect((await backend.readPage({ path: "replay.txt" })).content).toBe(
    "after\n",
  );
});

it("Glob and Grep provide recoverable pages and distinguish invalid searches from zero matches", async () => {
  const { rootDirectory, scope, backend: initial } = await fixture();
  await writeFile(join(rootDirectory, "a.ts"), "needle a\nneedle b\n");
  await writeFile(join(rootDirectory, "b.txt"), "needle c\n");
  const backend = createScopedBackend(scope, {
    limits: { ...initial.limits, codeSearchMaxResults: 1 },
  });
  const glob = await backend.globPage({ pattern: "**/*" });
  expect(glob.files.map((file) => file.path)).toEqual([
    join(rootDirectory, "a.ts"),
  ]);
  if (!glob.continuation) throw new Error("缺少Glob继续指针");
  const globNext = await backend.globPage({
    pattern: "**/*",
    continuation: glob.continuation,
  });
  expect(globNext.files.map((file) => file.path)).toEqual([
    join(rootDirectory, "b.txt"),
  ]);
  expect(globNext.truncated).toBe(false);
  const grep = await backend.grepPage({ pattern: "needle", glob: "*.ts" });
  expect(grep.matches).toEqual([
    { path: join(rootDirectory, "a.ts"), line: 1, text: "needle a" },
  ]);
  if (!grep.continuation) throw new Error("缺少Grep继续指针");
  const grepNext = await backend.grepPage({
    pattern: "needle",
    glob: "*.ts",
    continuation: grep.continuation,
  });
  expect(grepNext.matches).toEqual([
    { path: join(rootDirectory, "a.ts"), line: 2, text: "needle b" },
  ]);
  await expect(backend.grepPage({ pattern: "[" })).rejects.toThrow(
    /regex|正则/i,
  );
  expect((await backend.grepPage({ pattern: "absent" })).matches).toEqual([]);
  await expect(
    backend.grepPage({ pattern: "needle", path: "../outside" }),
  ).rejects.toThrow(/授权/);
});

it("images expose separate model blocks and preview metadata while unsupported models fail explicitly", async () => {
  const { backend, rootDirectory } = await fixture();
  const pixels = await sharp({
    create: { width: 2, height: 3, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await writeFile(join(rootDirectory, "image.png"), pixels);
  await expect(backend.readPage({ path: "image.png" })).rejects.toThrow();
  expect((await backend.readRaw("image.png")).data).toMatchObject({
    content: new Uint8Array(pixels),
    mimeType: "image/png",
  });
  expect((await backend.read("image.png")).content).toEqual(
    new Uint8Array(pixels),
  );
  await expect(
    backend.readMedia({
      path: "image.png",
      capabilities: { image: false, pdf: false },
    }),
  ).rejects.toThrow(/模型.*图片|image/i);
  const image = await backend.readMedia({
    path: "image.png",
    capabilities: { image: true, pdf: false },
  });
  expect(image).toMatchObject({
    type: "image",
    filePath: join(rootDirectory, "image.png"),
    mimeType: "image/png",
    dimensions: { originalWidth: 2, originalHeight: 3 },
  });
  expect(image.preview).toMatchObject({
    path: join(rootDirectory, "image.png"),
    mimeType: "image/png",
    sizeBytes: pixels.length,
  });
  expect(image.modelContent).toMatchObject([
    { type: "image", source_type: "base64", mime_type: "image/png" },
  ]);
});

it("PDF text extraction works without Poppler and native PDF models receive a file block", async () => {
  const { backend: initial, rootDirectory, scope } = await fixture();
  const backend = createScopedBackend(scope, {
    limits: { ...initial.limits, codePdfMaxPages: 1, codePdfRenderScale: 1 },
  });
  const data = makePdf("BT /F1 12 Tf 30 50 Td (Hello PDF) Tj ET");
  await writeFile(join(rootDirectory, "document.pdf"), data);
  const text = await backend.readMedia({
    path: "document.pdf",
    capabilities: { image: false, pdf: false },
  });
  expect(text.extractedText).toContain("Hello PDF");
  expect(text.modelContent[0]).toMatchObject({ type: "text" });
  const native = await backend.readMedia({
    path: "document.pdf",
    capabilities: { image: false, pdf: true },
  });
  expect(native.modelContent[0]).toMatchObject({
    type: "file",
    source_type: "base64",
    mime_type: "application/pdf",
  });
  expect(native.preview).toMatchObject({
    path: join(rootDirectory, "document.pdf"),
    mimeType: "application/pdf",
  });
  await expect(
    backend.readMedia({
      path: "document.pdf",
      pages: "2-1",
      capabilities: { image: false, pdf: true },
    }),
  ).rejects.toThrow(/页/);
});

it("image-only models can read PDF visible content by rasterizing authorized pages", async () => {
  const { backend: initial, rootDirectory, scope } = await fixture();
  const backend = createScopedBackend(scope, {
    limits: { ...initial.limits, codePdfMaxPages: 1, codePdfRenderScale: 2 },
  });
  await writeFile(
    join(rootDirectory, "scan.pdf"),
    makePdf("0 0 1 rg 10 10 80 80 re f"),
  );
  await expect(
    backend.readMedia({
      path: "scan.pdf",
      capabilities: { image: false, pdf: false },
    }),
  ).rejects.toThrow(/没有可提取文字/);
  const scanned = await backend.readMedia({
    path: "scan.pdf",
    capabilities: { image: true, pdf: false },
  });
  const image = scanned.modelContent.find((block) => block.type === "image");
  expect(image).toMatchObject({
    type: "image",
    source_type: "base64",
    mime_type: "image/png",
  });
  const pixels = await sharp(
    Buffer.from(String(image?.data), "base64"),
  ).metadata();
  expect([pixels.width, pixels.height]).toEqual([200, 200]);
  expect(scanned.preview.path).toBe(join(rootDirectory, "scan.pdf"));
});

it("search output byte truncation resumes within the same file without losing or repeating matches", async () => {
  const { backend: initial, rootDirectory, scope } = await fixture();
  await writeFile(
    join(rootDirectory, "many.txt"),
    Array.from({ length: 20 }, (_, index) => `needle ${index}\n`).join(""),
  );
  const backend = createScopedBackend(scope, {
    limits: { ...initial.limits, codeSearchMaxBytes: 1_024 },
  });
  let page = await backend.grepPage({ pattern: "needle" });
  const lines = page.matches.map((match) => match.line);
  expect(page.truncated).toBe(true);
  while (page.continuation) {
    page = await backend.grepPage({
      pattern: "needle",
      continuation: page.continuation,
    });
    lines.push(...page.matches.map((match) => match.line));
  }
  expect(lines).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
});

it("Task filesystem revocation waits for the current operation to finish and blocks new admissions", async () => {
  const { rootDirectory, scope } = await fixture();
  await writeFile(join(rootDirectory, "pending.txt"), "safe\n");
  const entered = deferred();
  const release = deferred();
  const original = scope.resolvePath;
  let gated = true;
  scope.resolvePath = async (path, operation) => {
    if (gated) {
      entered.resolve();
      await release.promise;
    }
    return original(path, operation);
  };
  const backend = createScopedBackend(scope);
  const reading = backend.readPage({ path: "pending.txt" }).then(
    () => "completed",
    () => "aborted",
  );
  await entered.promise;
  let settled = false;
  let stopping: Promise<void> | undefined;
  try {
    const identity = scope.describe();
    stopping = revokeTaskFileOperations(
      identity.instanceId,
      identity.taskId,
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(
      backend.writeFile({ path: "new.txt", content: "unsafe" }),
    ).rejects.toThrow(/撤销/);
  } finally {
    gated = false;
    release.resolve();
    await stopping;
  }
  expect(await reading).toBe("aborted");
  expect(settled).toBe(true);
  expect((await backend.readPage({ path: "pending.txt" })).content).toBe(
    "safe\n",
  );
});

it("all mutation/search/media producers honor a canceled call without changing user files", async () => {
  const { backend, rootDirectory } = await fixture();
  await writeFile(join(rootDirectory, "cancel.txt"), "before\n");
  await backend.readPage({ path: "cancel.txt" });
  const cancellation = new AbortController();
  cancellation.abort(new Error("用户取消"));
  const signal = cancellation.signal;
  await expect(
    backend.editFile({
      path: "cancel.txt",
      oldString: "before",
      newString: "after",
      signal,
    }),
  ).rejects.toThrow(/取消/);
  await expect(
    backend.applyPatch({
      patchText:
        "*** Begin Patch\n*** Update File: cancel.txt\n@@\n-before\n+after\n*** End Patch",
      signal,
    }),
  ).rejects.toThrow(/取消/);
  await expect(backend.grepPage({ pattern: "before", signal })).rejects.toThrow(
    /取消/,
  );
  await expect(backend.globPage({ pattern: "**/*", signal })).rejects.toThrow(
    /取消/,
  );
  await expect(
    backend.readMedia({
      path: "missing.png",
      capabilities: { image: true, pdf: false },
      signal,
    }),
  ).rejects.toThrow(/取消/);
  expect((await backend.readPage({ path: "cancel.txt" })).content).toBe(
    "before\n",
  );
});

it("checkpoint byte restore rechecks all observed versions, shares file locks and quiesces before admitting writes", async () => {
  const { backend, scope, rootDirectory } = await fixture();
  await writeFile(
    join(rootDirectory, "binary.dat"),
    Uint8Array.from([0, 1, 2]),
  );
  await writeFile(join(rootDirectory, "delete.txt"), "remove me\n");
  const binary = await backend.observeBinary("binary.dat");
  const deleted = await backend.observeBinary("delete.txt");
  let stopped = false;
  const result = await backend.commitBatch(
    [
      {
        path: binary.path,
        bytes: Uint8Array.from([0, 3, 4]),
        expectedVersion: binary.version,
      },
      { path: deleted.path, bytes: null, expectedVersion: deleted.version },
    ],
    async () => {
      stopped = true;
      return scope;
    },
  );
  expect(stopped).toBe(true);
  expect(result.failures).toEqual([]);
  expect(result.files.map((file) => file.type)).toEqual(["update", "delete"]);
  expect((await backend.readRaw("binary.dat")).data).toMatchObject({
    content: Uint8Array.from([0, 3, 4]),
  });
  expect((await backend.observeBinary("delete.txt")).version).toBeNull();
  const observed = await backend.observeBinary("binary.dat");
  await writeFile(join(rootDirectory, "binary.dat"), Uint8Array.from([0, 9]));
  const conflict = await backend.commitBatch(
    [
      {
        path: observed.path,
        bytes: Uint8Array.from([0, 5]),
        expectedVersion: observed.version,
      },
    ],
    async () => scope,
  );
  expect(conflict.files).toEqual([]);
  expect(conflict.failures[0]?.error).toMatch(/变化|version/i);
  expect((await backend.readRaw("binary.dat")).data).toMatchObject({
    content: Uint8Array.from([0, 9]),
  });
});

it("an in-flight large text read cancels and releases resources before Task revocation completes", async () => {
  const { backend, rootDirectory, scope } = await fixture();
  await writeFile(
    join(rootDirectory, "large.txt"),
    "long source line\n".repeat(1_000_000),
  );
  const controller = new AbortController();
  const reading = backend
    .readPage({ path: "large.txt", signal: controller.signal })
    .then(
      () => "completed",
      () => "aborted",
    );
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error("用户取消"));
  const identity = scope.describe();
  await revokeTaskFileOperations(identity.instanceId, identity.taskId);
  expect(await reading).toBe("aborted");
  expect(
    (await backend.readPage({ path: "large.txt", line: 1, limit: 1 })).content,
  ).toBe("long source line\n");
});

it("exact editing preserves UTF-16 byte encoding, CRLF and rejects ambiguous replacements", async () => {
  const { backend, rootDirectory } = await fixture();
  const path = join(rootDirectory, "utf16.txt");
  const original = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("first\r\nsecond\r\n", "utf16le"),
  ]);
  await writeFile(path, original);
  expect((await backend.readPage({ path: "utf16.txt" })).content).toBe(
    "first\r\nsecond\r\n",
  );
  await backend.editFile({
    path: "utf16.txt",
    oldString: "first\nsecond",
    newString: "updated\nsecond",
  });
  expect((await backend.readPage({ path: "utf16.txt" })).content).toBe(
    "updated\r\nsecond\r\n",
  );
  const binary = await import("node:fs/promises");
  expect(await binary.readFile(path)).toEqual(
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("updated\r\nsecond\r\n", "utf16le"),
    ]),
  );
  await backend.writeFile({ path: "duplicate.txt", content: "same same\n" });
  await expect(
    backend.editFile({
      path: "duplicate.txt",
      oldString: "same",
      newString: "one",
    }),
  ).rejects.toThrow(/unique|唯一/i);
  expect(
    (
      await backend.editFile({
        path: "duplicate.txt",
        oldString: "same",
        newString: "one",
        replaceAll: true,
      })
    ).occurrences,
  ).toBe(2);
});

it("patch Add/Move/Delete report actual commits and an old authorization generation cannot reuse model observations", async () => {
  const { backend, rootDirectory, scope } = await fixture();
  await writeFile(join(rootDirectory, "move.txt"), "old\n");
  await writeFile(join(rootDirectory, "delete.txt"), "delete\n");
  await backend.readPage({ path: "move.txt" });
  await backend.readPage({ path: "delete.txt" });
  const result = await backend.applyPatch({
    patchText:
      "*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: move.txt\n*** Move to: moved.txt\n@@\n-old\n+updated\n*** Delete File: delete.txt\n*** End Patch",
  });
  expect(result.failures).toEqual([]);
  expect(result.files.map((file) => file.type)).toEqual([
    "add",
    "move",
    "delete",
  ]);
  expect((await backend.readPage({ path: "moved.txt" })).content).toBe(
    "updated\n",
  );
  expect((await backend.observeBinary("move.txt")).version).toBeNull();
  const descriptor = scope.describe;
  scope.describe = () => ({ ...descriptor(), generation: 1 });
  await expect(
    backend.writeFile({ path: "moved.txt", content: "blind" }),
  ).rejects.toThrow(/读取/);
  expect((await backend.readPage({ path: "new.txt" })).content).toBe("new\n");
});

it("Task revoke cancels an in-flight native search and waits for its child and input stream to close", async () => {
  const { backend, rootDirectory, scope } = await fixture();
  await writeFile(
    join(rootDirectory, "large-search.txt"),
    "searchable text line\n".repeat(1_000_000),
  );
  const validating = deferred();
  const releaseValidation = deferred();
  const resolvePath = scope.resolvePath;
  let validations = 0;
  scope.resolvePath = async (path, operation) => {
    const canonical = await resolvePath(path, operation);
    // 在文件已打开后的授权复验处撤销，稳定覆盖流创建之前的取消窗口。
    if (canonical === join(rootDirectory, "large-search.txt")) {
      validations += 1;
      if (validations === 3) {
        validating.resolve();
        await releaseValidation.promise;
      }
    }
    return canonical;
  };
  const searching = backend.grepPage({ pattern: "absent-pattern" }).then(
    () => "completed",
    () => "aborted",
  );
  await validating.promise;
  const identity = scope.describe();
  const revoking = revokeTaskFileOperations(
    identity.instanceId,
    identity.taskId,
  );
  releaseValidation.resolve();
  await revoking;
  expect(await searching).toBe("aborted");
  expect(
    (await backend.grepPage({ pattern: "searchable", limit: 1 })).matches[0]
      ?.line,
  ).toBe(1);
});
