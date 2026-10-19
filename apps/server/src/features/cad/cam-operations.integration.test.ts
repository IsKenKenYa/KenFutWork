import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { detectFreeCadRuntime } from "./runtime.js";
import { invokeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";
type Point = [number, number, number];
type Block = { codes: number[]; words: Record<string, number> };
type Motion = {
  code: number;
  from: Point;
  to: Point;
  center: [number, number] | null;
  feed: number | null;
};
const commandSchema = z.object({
  name: z.string(),
  parameters: z.record(z.string(), z.number().finite()),
});

function ncBlocks(text: string): Block[] {
  return text.split(/\r?\n/u).flatMap((raw) => {
    const line =
      raw
        .replace(/\([^)]*\)/gu, "")
        .split(";")[0]
        ?.replaceAll("%", "")
        .trim() ?? "";
    if (!line) return [];
    const words: Record<string, number> = {},
      codes: number[] = [];
    const remainder = line.replace(
      /([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/giu,
      (_word, letter: string, value: string) => {
        const key = letter.toUpperCase(),
          numeric = Number(value);
        expect(Number.isFinite(numeric)).toBe(true);
        if (key === "G") codes.push(numeric);
        else words[key] = numeric;
        return "";
      },
    );
    expect(remainder.trim(), `未识别的NC语句：${line}`).toBe("");
    return [{ codes, words }];
  });
}

function checkModes(blocks: Block[]) {
  const selected: Record<string, number> = {};
  const groups = [
    { name: "units", codes: [20, 21] },
    { name: "distance", codes: [90, 91] },
    { name: "plane", codes: [17, 18, 19] },
    { name: "feed", codes: [93, 94, 95] },
    { name: "arc", codes: [90.1, 91.1] },
    { name: "fixture", codes: [54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3] },
  ];
  let motion: number | undefined,
    lengthCompTool: number | null = null;
  for (const block of blocks) {
    for (const code of block.codes) {
      for (const group of groups)
        if (group.codes.includes(code)) selected[group.name] = code;
      if ([0, 1, 2, 3].includes(code)) motion = code;
      if (code === 49) lengthCompTool = null;
      if (code === 43) lengthCompTool = block.words.H ?? null;
    }
    if (
      motion === undefined ||
      !["X", "Y", "Z", "I", "J"].some((key) => block.words[key] !== undefined)
    )
      continue;
    expect(selected, "运动前必须建立单位、坐标和工件坐标系").toMatchObject({
      units: 21,
      distance: 90,
      fixture: 54,
    });
    expect(lengthCompTool, "运动前必须启用所选刀具的长度补偿").toBe(1);
    if (motion !== 0)
      expect(selected.feed, "切削前必须建立每分钟进给").toBe(94);
    if (motion === 2 || motion === 3)
      expect(selected, "圆弧前必须建立XY平面与增量I/J").toMatchObject({
        plane: 17,
        arc: 91.1,
      });
  }
}

test("NC单位与坐标模式必须在运动前声明，不能用结束前的声明补齐", () => {
  const lateModes = ncBlocks(
    "G0 Z10\nG1 X43 Y20 Z4 F300\nG17 G54 G40 G49 G80 G90 G94 G91.1\nG21\nG43 H1\nM2",
  );
  expect(() => checkModes(lateModes)).toThrow();
  const valid = ncBlocks(
    "G17 G54 G40 G49 G80 G90 G94 G91.1\nG21\nG43 H1\nG0 Z10\nG1 X43 Y20 Z4 F300\nM2",
  );
  expect(() => checkModes(valid)).not.toThrow();
  expect(() =>
    checkModes(ncBlocks("G17 G54 G90 G94 G91.1 G21 G43 H1\nG55\nG0 Z10")),
  ).toThrow();
});

/** 本代表流程只验证绝对XYZ、XY增量I/J圆弧及mm/min；不充当通用机床解释器。 */
function motions(blocks: Block[], feedScale: number): Motion[] {
  const result: Motion[] = [];
  let position: Point = [0, 0, 0],
    mode: number | undefined,
    feed: number | null = null;
  for (const block of blocks) {
    for (const code of block.codes) {
      if ([20, 18, 19, 90.1, 91, 93, 95, 53, 92, 41, 42].includes(code))
        throw new Error(`该NC超出验收坐标约定：G${code}`);
      if ([0, 1, 2, 3].includes(code)) mode = code;
    }
    const words = block.words;
    if (words.F !== undefined) feed = words.F * feedScale;
    const hasAxes = ["X", "Y", "Z"].some((key) => words[key] !== undefined);
    const hasArc =
      (mode === 2 || mode === 3) &&
      (words.I !== undefined || words.J !== undefined);
    if (!hasAxes && !hasArc) continue;
    if (mode === undefined) throw new Error("运动缺少G0/G1/G2/G3模态");
    expect(words.R).toBeUndefined();
    if (words.K !== undefined) expect(words.K).toBe(0);
    const to: Point = [
      words.X ?? position[0],
      words.Y ?? position[1],
      words.Z ?? position[2],
    ];
    let center: [number, number] | null = null;
    if (mode === 2 || mode === 3) {
      center = [position[0] + (words.I ?? 0), position[1] + (words.J ?? 0)];
      const radius = Math.hypot(
        position[0] - center[0],
        position[1] - center[1],
      );
      expect(radius).toBeGreaterThan(0);
      expect(Math.hypot(to[0] - center[0], to[1] - center[1])).toBeCloseTo(
        radius,
        5,
      );
    }
    if (mode !== 0) expect(feed).toBeGreaterThan(0);
    if (
      center ||
      ([0, 1, 2] as const).some(
        (axis) => Math.abs(to[axis] - position[axis]) > 1e-9,
      )
    )
      result.push({
        code: mode,
        from: position,
        to,
        center,
        feed: mode === 0 ? null : feed,
      });
    position = to;
  }
  return result;
}

function internalBlocks(raw: unknown): Block[] {
  return z
    .array(commandSchema)
    .min(1)
    .parse(raw)
    .map((command) => {
      const match = /^G(\d+(?:\.\d+)?)$/u.exec(command.name);
      return {
        codes: match?.[1] ? [Number(match[1])] : [],
        words: command.parameters,
      };
    });
}

function compareMotions(internal: Motion[], output: Motion[]) {
  expect(output.length).toBe(internal.length);
  for (const [index, expected] of internal.entries()) {
    const actual = output[index];
    if (!actual) throw new Error("NC缺少对应运动");
    expect(actual.code).toBe(expected.code);
    for (const field of ["from", "to"] as const)
      for (const axis of [0, 1, 2] as const)
        expect(actual[field][axis]).toBeCloseTo(expected[field][axis], 5);
    expect(actual.center === null).toBe(expected.center === null);
    if (actual.center && expected.center)
      for (const axis of [0, 1] as const)
        expect(actual.center[axis]).toBeCloseTo(expected.center[axis], 5);
    if (expected.feed === null) expect(actual.feed).toBeNull();
    else expect(actual.feed).toBeCloseTo(expected.feed, 5);
  }
}

function checkSpindle(blocks: Block[]) {
  let mode: number | undefined,
    clockwise = false,
    speed = 0,
    tool = 0,
    cuts = 0,
    changed = false;
  for (const block of blocks) {
    for (const code of block.codes)
      if ([0, 1, 2, 3].includes(code)) mode = code;
    const words = block.words;
    if (words.S !== undefined) speed = words.S;
    if (words.T !== undefined) tool = words.T;
    if (words.M === 6) {
      expect(tool).toBe(1);
      changed = true;
    }
    if (words.M === 3) clockwise = true;
    if (words.M === 4 || words.M === 5) clockwise = false;
    if (
      mode !== undefined &&
      mode !== 0 &&
      ["X", "Y", "Z", "I", "J"].some((key) => words[key] !== undefined)
    ) {
      expect(changed).toBe(true);
      expect(clockwise).toBe(true);
      expect(speed).toBe(12000);
      cuts++;
    }
  }
  expect(cuts).toBeGreaterThan(0);
  expect(clockwise).toBe(false);
  expect(blocks.at(-1)?.words.M).toBe(2);
}

function arcSweep(move: Motion) {
  if (!move.center) return 0;
  const [x, y] = move.center;
  const start = Math.atan2(move.from[1] - y, move.from[0] - x);
  const end = Math.atan2(move.to[1] - y, move.to[0] - x);
  const turn = Math.PI * 2;
  const ccw = (((end - start) % turn) + turn) % turn;
  return move.code === 2 ? ccw - turn : ccw;
}

function checkOffsetLoop(moves: Motion[], length: number) {
  const first = moves[0],
    last = moves.at(-1);
  if (!first || !last) throw new Error("CAM切削层为空");
  expect(last.to[0]).toBeCloseTo(first.from[0], 6);
  expect(last.to[1]).toBeCloseTo(first.from[1], 6);
  let area = 0,
    turn = 0;
  for (const move of moves) {
    let middle = [
      (move.from[0] + move.to[0]) / 2,
      (move.from[1] + move.to[1]) / 2,
    ];
    if (move.center) {
      const [cx, cy] = move.center,
        radius = Math.hypot(move.from[0] - cx, move.from[1] - cy),
        sweep = arcSweep(move);
      expect(radius).toBeCloseTo(3, 6);
      expect(Math.abs(sweep)).toBeGreaterThan(0);
      expect(Math.abs(sweep)).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);
      turn += sweep;
      const angle =
        Math.atan2(move.from[1] - cy, move.from[0] - cx) + sweep / 2;
      middle = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
      area +=
        (cx * (move.to[1] - move.from[1]) -
          cy * (move.to[0] - move.from[0]) +
          radius * radius * sweep) /
        2;
    } else area += (move.from[0] * move.to[1] - move.to[0] * move.from[1]) / 2;
    for (const point of [move.from, move.to, middle]) {
      const x = point[0] ?? NaN,
        y = point[1] ?? NaN;
      expect(
        Math.hypot(Math.max(0, -x, x - length), Math.max(0, -y, y - 20)),
      ).toBeCloseTo(3, 6);
    }
  }
  expect(turn).toBeCloseTo(-2 * Math.PI, 6);
  expect(area).toBeCloseTo(-(length * 20 + 6 * (length + 20) + 9 * Math.PI), 5);
}

function checkContour(
  trace: Motion[],
  length: number,
  sectionTolerance: number,
) {
  const layers = new Map<number, Motion[]>();
  expect(Math.max(...trace.map((move) => move.to[2]))).toBeCloseTo(10, 6);
  for (const move of trace) {
    const horizontal =
      Math.hypot(move.to[0] - move.from[0], move.to[1] - move.from[1]) > 1e-9 ||
      move.center !== null;
    if (move.code === 0) {
      if (horizontal)
        expect(Math.min(move.from[2], move.to[2])).toBeGreaterThanOrEqual(8);
      continue;
    }
    expect(move.to[2]).toBeGreaterThanOrEqual(0);
    if (!horizontal) {
      expect(move.feed).toBeCloseTo(120, 6);
      continue;
    }
    expect(move.from[2]).toBeCloseTo(move.to[2], 6);
    expect(move.to[2]).toBeLessThanOrEqual(5);
    expect(move.feed).toBeCloseTo(300, 6);
    const group = layers.get(move.to[2]) ?? [];
    group.push(move);
    layers.set(move.to[2], group);
  }
  const depths = [...layers.keys()].sort((a, b) => a - b);
  // Area.cpp 将触底截面改为 zMin + SectionTolerance；不把它误当后处理舍入。
  expect(sectionTolerance).toBeCloseTo(0.000001, 12);
  expect(depths).toHaveLength(5);
  depths.forEach((value, index) => {
    expect(value).toBeCloseTo(index === 0 ? sectionTolerance : index, 6);
  });
  for (let i = 1; i < depths.length; i++)
    expect((depths[i] ?? NaN) - (depths[i - 1] ?? NaN)).toBeLessThanOrEqual(1);
  for (const moves of layers.values()) checkOffsetLoop(moves, length);
}

const stageSchema = z.object({
  parameters: z
    .object({
      length: z.number().positive(),
      sectionToleranceMm: z.number().positive(),
    })
    .passthrough(),
  commands: z.array(commandSchema),
  ncPath: z.string(),
  ncBytes: z.number().int().positive(),
  ncSha256: z.string(),
  postprocessResult: z
    .array(z.tuple([z.literal("allitems"), z.string().min(1)]))
    .length(1),
  stockBounds: z.array(z.number().finite()).length(6),
  stockAllowances: z.object({
    negative: z.tuple([z.literal(3), z.literal(3), z.literal(0)]),
    positive: z.tuple([z.literal(3), z.literal(3), z.literal(0)]),
  }),
  postprocessor: z.object({
    source_path: z.string(),
    module_path: z.string(),
    export_source_path: z.string(),
    sha256: z.string(),
    name: z.literal("linuxcnc"),
    args: z.string(),
  }),
});

async function checkStage(stage: z.infer<typeof stageSchema>, root: string) {
  const nc = await readFile(stage.ncPath, "utf8");
  expect(await realpath(stage.ncPath)).toBe(stage.ncPath);
  expect(stage.ncPath.startsWith(`${root}/`)).toBe(true);
  expect(Buffer.byteLength(nc)).toBe(stage.ncBytes);
  expect(createHash("sha256").update(nc).digest("hex")).toBe(stage.ncSha256);
  expect(stage.postprocessResult[0]?.[1]).toBe(nc);
  const runtime = await detectFreeCadRuntime();
  if (!runtime) throw new Error("原生CAM验收要求已安装FreeCAD");
  const expectedPost = await realpath(
    join(
      runtime.runtimeRoot,
      "Contents/Resources/Mod/CAM/Path/Post/scripts/linuxcnc_post.py",
    ),
  );
  expect(stage.postprocessor.source_path).toBe(expectedPost);
  expect(stage.postprocessor.module_path).toBe(expectedPost);
  expect(stage.postprocessor.export_source_path).toBe(expectedPost);
  expect(
    createHash("sha256")
      .update(await readFile(expectedPost))
      .digest("hex"),
  ).toBe(stage.postprocessor.sha256);
  const expectedBounds = [-3, -3, 0, stage.parameters.length + 3, 23, 5];
  stage.stockBounds.forEach((value, axis) => {
    expect(value).toBeCloseTo(expectedBounds[axis] ?? NaN, 6);
  });
  expect(stage.parameters).toMatchObject({
    width: 20,
    height: 5,
    toolDiameter: 6,
    toolNumber: 1,
    spindleSpeedRpm: 12000,
    nativeFeedMmPerSecond: { horizontal: 5, vertical: 2 },
    requestedFeedMmPerMinute: { horizontal: 300, vertical: 120 },
    ncFeedMmPerMinute: { horizontal: 300, vertical: 120 },
    depths: {
      StartDepth: 5,
      FinalDepth: 0,
      StepDown: 1,
      SafeHeight: 8,
      ClearanceHeight: 10,
    },
  });
  const blocks = ncBlocks(nc);
  checkModes(blocks);
  checkSpindle(blocks);
  const expected = motions(internalBlocks(stage.commands), 60),
    actual = motions(blocks, 1);
  compareMotions(expected, actual);
  checkContour(
    actual,
    stage.parameters.length,
    stage.parameters.sectionToleranceMm,
  );
}

const camDataSchema = z.object({
  capability: z.literal("cam_profile"),
  reused: z.boolean(),
  stages: z.array(stageSchema).length(2),
  objects: z.object({
    source: z.string(),
    job: z.string(),
    operation: z.string(),
    models: z.array(z.string()).length(1),
    stock: z.string(),
    controller: z.string(),
    tool: z.string(),
  }),
  relations: z.object({
    modelSources: z.array(z.string()),
    stockBase: z.string(),
    operations: z.array(z.string()),
    controllers: z.array(z.string()),
    operationController: z.string(),
    controllerTool: z.string(),
  }),
});

async function checkCam(
  raw: ReturnType<typeof cadResultSchema.parse>,
  expectedLengths: number[],
  root: string,
  seen: Map<string, string>,
  reused: boolean,
) {
  const data = camDataSchema.parse(raw.data);
  expect(data.reused).toBe(reused);
  expect(data.stages.map((stage) => stage.parameters.length)).toEqual(
    expectedLengths,
  );
  expect(data.relations).toMatchObject({
    modelSources: [data.objects.source],
    operations: [data.objects.operation],
    controllers: [data.objects.controller],
    operationController: data.objects.controller,
    controllerTool: data.objects.tool,
  });
  for (const stage of data.stages) {
    expect(seen.has(stage.ncPath)).toBe(false);
    seen.set(stage.ncPath, stage.ncSha256);
    await checkStage(stage, root);
  }
  for (const name of [data.objects.source, ...data.objects.models])
    expect(
      raw.document?.objects.find((object) => object.name === name)?.shape
        ?.volume,
    ).toBeCloseTo((expectedLengths.at(-1) ?? NaN) * 100, 6);
  return data;
}

async function camSource(options: Record<string, unknown>) {
  const fixture = await readFile(
    new URL("./fixtures/cam-profile.py", import.meta.url),
    "utf8",
  );
  return `import json\n${fixture}\nresult=run_profile_case(json.loads(${JSON.stringify(JSON.stringify(options))}))`;
}

test.skipIf(nativeUnavailable)(
  "CAM真实Job外轮廓经LinuxCNC后处理写新NC，与内部运动逐段核对后保存重开",
  async () =>
    withNativeCad(async (fixture) => {
      const seen = new Map<string, string>();
      let path: string | undefined;
      for (const [index, [length, resizedLength]] of (
        [
          [40, 50],
          [50, 70],
          [70, 40],
        ] as const
      ).entries()) {
        const before = path ? await readFile(path) : undefined;
        const solved = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            ...(path ? { documentPath: path } : {}),
            source: await camSource({ length, resizedLength }),
            requireSolids: true,
          },
          `cam-profile-round-${index}`,
        );
        expect(solved.isError, JSON.stringify(solved)).not.toBe(true);
        const checked = cadResultSchema.parse(solved.structuredContent);
        await checkCam(
          checked,
          [length, resizedLength],
          fixture.root,
          seen,
          index > 0,
        );
        if (path) expect(await readFile(path)).toEqual(before);
        path = z.string().parse(checked.outputPath);
      }
      expect(seen.size).toBe(6);
      for (const [ncPath, hash] of seen)
        expect(
          createHash("sha256")
            .update(await readFile(ncPath))
            .digest("hex"),
        ).toBe(hash);
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "CAM后处理不存在或只有非空首尾段时明确拒绝交付，保留源工程",
  async () =>
    withNativeCad(async (fixture) => {
      const baseline = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        { source: await camSource({}), requireSolids: true },
        "cam-failure-baseline",
      );
      expect(baseline.isError, JSON.stringify(baseline)).not.toBe(true);
      const sourcePath = z
        .string()
        .parse(cadResultSchema.parse(baseline.structuredContent).outputPath);
      const bytes = await readFile(sourcePath);
      const fixtureSource = await readFile(
        new URL("./fixtures/cam-profile.py", import.meta.url),
        "utf8",
      );
      const cases = [
        {
          name: "missing-post",
          source: [
            "post = PostProcessorFactory.get_post_processor(job, 'kfw_nonexistent_acceptance_post')",
            "_cam_require(post is not None, '未找到指定的CAM后处理器')",
          ],
          error: "未找到指定的CAM后处理器",
        },
        {
          name: "header-only",
          source: [
            "job.Operations.Group = []",
            "post = PostProcessorFactory.get_post_processor(job, 'linuxcnc')",
            "_cam_require(isinstance(post, WrapperPost), '未加载实际linuxcnc')",
            "sections = post.export()",
            "_cam_require(len(sections)==1 and isinstance(sections[0][1],str) and sections[0][1].strip(), '本例需验证非空但无切削的真实导出')",
            "parsed = Path.Path(sections[0][1])",
            "cutting = [command for command in parsed.Commands if command.Name in ('G1','G2','G3') and any(axis in command.Parameters for axis in ('X','Y','Z','I','J'))]",
            "_cam_require(cutting, 'CAM后处理没有有效切削运动，不能仅凭非空NC交付')",
          ],
          error: "CAM后处理没有有效切削运动",
        },
      ];
      for (const item of cases) {
        const outputPath = join(fixture.root, `${item.name}.FCStd`);
        const rejected = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            documentPath: sourcePath,
            outputPath,
            requireSolids: true,
            source: [
              fixtureSource,
              "job = doc.getObject('KfwCamJob')",
              ...item.source,
            ].join("\n"),
          },
          `cam-${item.name}`,
        );
        expect(rejected).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "execution_failed" } },
        });
        expect(JSON.stringify(rejected)).toContain(item.error);
        await expect(stat(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(sourcePath)).toEqual(bytes);
      }
    }),
  90_000,
);
