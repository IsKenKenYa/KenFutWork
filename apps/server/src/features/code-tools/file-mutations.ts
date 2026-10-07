import { unlink } from "node:fs/promises";
import { structuredPatch } from "diff";
import {
  applyChunks,
  parsePatch,
} from "../../../../../packages/third-party/codex-patch/apply-patch.js";
import { EditService } from "../../../../../packages/third-party/kimi-edit/editService.js";
import { TextModel } from "../../../../../packages/third-party/kimi-edit/textModel.js";
import { errorText, type ScopedFileController } from "./file-controller.js";
import type {
  EditCommit,
  EditFileInput,
  FileCommit,
  FileLimits,
  PatchFileChange,
  PatchInput,
  PatchResult,
  WriteFileInput,
} from "./file-types.js";

class FileMutations {
  constructor(
    private readonly controller: ScopedFileController,
    private readonly limits: FileLimits,
  ) {}
  private async writeFileOnce(input: WriteFileInput): Promise<FileCommit> {
    const path = await this.controller.resolveWrite(input.path, input.signal);
    return this.controller.withLocks(
      [path],
      async () => {
        if (
          (await this.controller.resolveWrite(input.path, input.signal)) !==
          path
        )
          throw new Error("文件路径已变化");
        const before = await this.controller.load(path, input.signal);
        if (before && input.createOnly)
          throw new Error("新建文件禁止覆盖现存文件");
        if (
          !before &&
          (input.expectedVersion !== undefined ||
            (!input.createOnly &&
              this.controller.currentObservations().has(path)))
        )
          throw new Error(
            "已读取的文件已删除或变化；重新创建必须显式使用 createOnly",
          );
        if (before)
          this.controller.assertObserved(path, before, input.expectedVersion);
        return this.controller.publish(
          path,
          input.content,
          before,
          undefined,
          input.signal,
        );
      },
      input.signal,
    );
  }
  private async editFileOnce(input: EditFileInput): Promise<EditCommit> {
    if (input.oldString === input.newString)
      throw new Error("old_string 与 new_string 相同，没有修改");
    const path = await this.controller.resolveWrite(input.path, input.signal);
    return this.controller.withLocks(
      [path],
      async () => {
        if (
          (await this.controller.resolveWrite(input.path, input.signal)) !==
          path
        )
          throw new Error("文件路径已变化");
        const before = await this.controller.load(path, input.signal);
        if (!before) {
          if (input.oldString !== "") throw new Error("文件不存在");
          return {
            ...(await this.controller.publish(
              path,
              input.newString,
              undefined,
              undefined,
              input.signal,
            )),
            oldString: "",
            newString: input.newString,
            replaceAll: false,
            occurrences: 1,
            matchStrategy: "exact",
          };
        }
        const observation = this.controller.assertObserved(
          path,
          before,
          input.expectedVersion,
          false,
        );
        if (input.oldString === "")
          throw new Error("新建文件禁止覆盖现存文件；old_string 不能为空");
        const model = new TextModel(before.text);
        const oldString = new TextModel(input.oldString).text;
        const newString = new TextModel(input.newString).text;
        const spans: Array<{
          start: number;
          end: number;
          replacementLength: number;
        }> = [];
        let cursor = 0;
        while (cursor < model.text.length) {
          const index = model.text.indexOf(oldString, cursor);
          if (index < 0) break;
          const start = model.materialize(model.text.slice(0, index)).length;
          const end = start + model.materialize(oldString).length;
          if (
            !observation.full &&
            !observation.ranges.some(
              (range) => range.start <= start && range.end >= end,
            )
          )
            throw new Error("必须先读取要编辑的原文范围");
          spans.push({
            start,
            end,
            replacementLength: model.materialize(newString).length,
          });
          cursor = index + oldString.length;
        }
        const applied = new EditService().apply(model, {
          path,
          old_string: oldString,
          new_string: newString,
          replace_all: input.replaceAll ?? false,
        });
        if (!applied.ok) throw new Error(applied.error);
        const moveBoundary = (position: number, end: boolean) => {
          let delta = 0;
          for (const span of spans) {
            if (position < span.start) break;
            if (position <= span.end)
              return span.start + delta + (end ? span.replacementLength : 0);
            delta += span.replacementLength - (span.end - span.start);
          }
          return position + delta;
        };
        const nextObservation = {
          full: observation.full,
          ranges: observation.ranges.map((range) => ({
            start: moveBoundary(range.start, false),
            end: moveBoundary(range.end, true),
          })),
        };
        const committed = await this.controller.publish(
          path,
          applied.rawContent,
          before,
          nextObservation,
          input.signal,
        );
        return {
          ...committed,
          oldString: input.oldString,
          newString: input.newString,
          replaceAll: input.replaceAll ?? false,
          occurrences: applied.count,
          matchStrategy: "exact",
        };
      },
      input.signal,
    );
  }
  private patchChange(
    commit: FileCommit,
    type: PatchFileChange["type"],
    movePath?: string,
  ): PatchFileChange {
    return {
      filePath: commit.filePath,
      type,
      ...(movePath ? { movePath } : {}),
      structuredPatch: commit.structuredPatch,
      additions: commit.structuredPatch
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.startsWith("+")).length,
      deletions: commit.structuredPatch
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.startsWith("-")).length,
      version: commit.version,
    };
  }
  private async applyPatchOnce(input: PatchInput): Promise<PatchResult> {
    if (Buffer.byteLength(input.patchText) > this.limits.codePatchMaxBytes)
      throw new Error("补丁超过字节上限");
    const hunks = parsePatch(input.patchText);
    const files: PatchFileChange[] = [];
    const failures: PatchResult["failures"] = [];
    for (const hunk of hunks) {
      try {
        if (hunk.type === "add") {
          files.push(
            this.patchChange(
              await this.writeFile({
                path: hunk.path,
                content: hunk.content,
                createOnly: true,
                signal: input.signal,
              }),
              "add",
            ),
          );
          continue;
        }
        const path = await this.controller.resolveWrite(
          hunk.path,
          input.signal,
        );
        const destination =
          hunk.type === "update" && hunk.movePath
            ? await this.controller.resolveWrite(hunk.movePath, input.signal)
            : undefined;
        await this.controller.withLocks(
          destination ? [path, destination] : [path],
          async () => {
            if (
              (await this.controller.resolveWrite(hunk.path, input.signal)) !==
              path
            )
              throw new Error("文件路径已变化");
            const before = await this.controller.load(path, input.signal);
            if (!before) throw new Error("文件不存在");
            const observation = this.controller.assertObserved(
              path,
              before,
              undefined,
              hunk.type === "delete",
            );
            if (hunk.type === "delete") {
              if (
                (await this.controller.resolveWrite(
                  hunk.path,
                  input.signal,
                )) !== path ||
                (await this.controller.load(path, input.signal))?.version !==
                  before.version
              )
                throw new Error("文件在删除前变化");
              input.signal?.throwIfAborted();
              await unlink(path);
              files.push(
                this.patchChange(
                  {
                    type: "delete",
                    filePath: path,
                    content: "",
                    originalFile: before.text,
                    structuredPatch: structuredPatch(
                      path,
                      path,
                      before.text,
                      "",
                      undefined,
                      undefined,
                      { context: 0 },
                    ).hunks,
                    version: before.version,
                    userModified: false,
                  },
                  "delete",
                ),
              );
              return;
            }
            const applied = applyChunks(before.text, hunk.chunks);
            if (
              !observation.full &&
              applied.observedRanges.some(
                (span) =>
                  !observation.ranges.some(
                    (range) =>
                      range.start <= span.start && range.end >= span.end,
                  ),
              )
            )
              throw new Error("必须先读取要修改的补丁原文范围");
            if (!hunk.movePath) {
              files.push(
                this.patchChange(
                  await this.controller.publish(
                    path,
                    applied.content,
                    before,
                    observation.full ? undefined : { full: false, ranges: [] },
                    input.signal,
                  ),
                  "update",
                ),
              );
              return;
            }
            if (
              !destination ||
              (await this.controller.resolveWrite(
                hunk.movePath,
                input.signal,
              )) !== destination
            )
              throw new Error("移动目标路径已变化");
            if (destination === path)
              throw new Error("Move to 目标与源文件相同");
            if (await this.controller.load(destination, input.signal))
              throw new Error("移动禁止覆盖现存目标");
            const committed = await this.controller.publish(
              destination,
              applied.content,
            );
            if (
              (await this.controller.resolveWrite(hunk.path, input.signal)) !==
                path ||
              (await this.controller.load(path, input.signal))?.version !==
                before.version
            ) {
              files.push(this.patchChange(committed, "add"));
              throw new Error("目标已提交，但源文件在移动前变化，保留源文件");
            }
            try {
              input.signal?.throwIfAborted();
              await unlink(path);
            } catch (error) {
              files.push(this.patchChange(committed, "add"));
              throw error;
            }
            files.push({
              ...this.patchChange(committed, "move", destination),
              filePath: path,
            });
          },
          input.signal,
        );
      } catch (error) {
        failures.push({ filePath: hunk.path, error: errorText(error) });
        break;
      }
    }
    return {
      files,
      failures,
      structuredPatch: files.flatMap((file) => file.structuredPatch),
      summary: `已提交 ${files.length} 个文件${failures.length ? `，失败 ${failures.length} 个，后续文件未执行` : ""}`,
    };
  }
  writeFile(input: WriteFileInput): Promise<FileCommit> {
    return this.controller.replayMutation(
      "write",
      { ...input },
      [input.path],
      () => this.writeFileOnce(input),
    );
  }
  editFile(input: EditFileInput): Promise<EditCommit> {
    return this.controller.replayMutation(
      "edit",
      { ...input },
      [input.path],
      () => this.editFileOnce(input),
    );
  }
  applyPatch(input: PatchInput): Promise<PatchResult> {
    if (Buffer.byteLength(input.patchText) > this.limits.codePatchMaxBytes)
      return Promise.reject(new Error("补丁超过字节上限"));
    return this.controller.replayMutation(
      "patch",
      { ...input },
      parsePatch(input.patchText).flatMap((hunk) =>
        hunk.type === "update" && hunk.movePath
          ? [hunk.path, hunk.movePath]
          : [hunk.path],
      ),
      () => this.applyPatchOnce(input),
    );
  }
}

export function createFileMutations(
  controller: ScopedFileController,
  limits: FileLimits,
) {
  const mutations = new FileMutations(controller, limits);
  return {
    writeFile: (input: WriteFileInput) => mutations.writeFile(input),
    editFile: (input: EditFileInput) => mutations.editFile(input),
    applyPatch: (input: PatchInput) => mutations.applyPatch(input),
  };
}
