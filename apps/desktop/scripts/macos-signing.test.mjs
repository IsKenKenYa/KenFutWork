import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureMacosAppSeal } from "./macos-signing.mjs";

const options = { skip: process.platform === "win32" };

/**
 * 外部codesign CLI协议夹具；自家收集器/策略模块直接执行，不mock。
 * `nested` 给出要伪装成 Mach-O 的相对路径（写死 64 位 Mach-O 魔数），用来断言
 * 「先逐个封嵌套二进制、再封外层 bundle」这个顺序。
 */
async function fixture(input, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "kfw-signing-"));
  const app = join(root, "KenFutWork.app");
  const command = join(root, "codesign");
  await mkdir(app);
  for (const relative of options.nested ?? []) {
    const file = join(app, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  }
  const statePath = join(app, "signature-fixture.json");
  await writeFile(statePath, JSON.stringify({ ...input, calls: [] }));
  await writeFile(
    command,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const APP=${JSON.stringify(app)};
const target=args.at(-1);
const file=path.join(APP,'signature-fixture.json');
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const rel=path.relative(APP,target), isNested=target!==APP;
const relList=()=>[...new Set(state.sealedNested??[])];
if(args.includes('--verify')){
 state.calls.push(isNested?'verify:'+rel:'verify');save();
 // 外层与内部各文件分开记账：真实 codesign 就是「外层 --deep 过了，散装 Mach-O 仍未封印」。
 process.exit(isNested?(relList().includes(rel)?0:1):(state.sealed?0:1));
}
if(isNested){
 state.calls.push('sign:'+rel);
 state.sealedNested=[...new Set([...relList(),rel])];
 save();process.exit(state.nestedFails?1:0);
}
if(args.includes('--display')){
 state.calls.push('display');save();
 if(state.kind==='unsigned'){console.error('code object is not signed at all');process.exit(1);}
 if(state.kind==='unknown'){console.error('cannot inspect object');process.exit(1);}
 console.error(state.kind==='adhoc'?'Signature=adhoc\\nTeamIdentifier=not set':'Authority=Developer ID Application: Fixture\\nTeamIdentifier=TESTTEAM');process.exit(0);
}
if(args.includes('--sign')){state.calls.push('sign');if(!state.signFails){state.kind='adhoc';state.sealed=!state.corruptAfterSigning;}save();process.exit(state.signFails?1:0);}
process.exit(2);`,
  );
  await chmod(command, 0o755);
  return {
    app,
    command,
    read: async () => JSON.parse(await readFile(statePath, "utf8")),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

for (const kind of ["developer-id", "adhoc"]) {
  test(`有效${kind}包保持原签名，不调用重签`, options, async () => {
    const current = await fixture({ kind, sealed: true });
    try {
      assert.equal(
        ensureMacosAppSeal(current.app, current.command).repaired,
        false,
      );
      assert.deepEqual((await current.read()).calls, ["verify"]);
      assert.equal((await current.read()).kind, kind);
    } finally {
      await current.close();
    }
  });
}

test(
  "证书签名损坏或无法检查时拒绝降级，不调用ad-hoc重签",
  options,
  async () => {
    for (const kind of ["developer-id", "unknown"]) {
      const current = await fixture({ kind, sealed: false });
      try {
        assert.throws(() => ensureMacosAppSeal(current.app, current.command));
        assert.deepEqual((await current.read()).calls, ["verify", "display"]);
        assert.equal((await current.read()).kind, kind);
      } finally {
        await current.close();
      }
    }
  },
);

test("未签名/ad-hoc包可补封印，补后仍必须严格验证", options, async () => {
  for (const kind of ["unsigned", "adhoc"]) {
    const current = await fixture({ kind, sealed: false });
    try {
      assert.equal(
        ensureMacosAppSeal(current.app, current.command).repaired,
        true,
      );
      assert.deepEqual((await current.read()).calls, [
        "verify",
        "display",
        "sign",
        "verify",
      ]);
      assert.equal((await current.read()).sealed, true);
    } finally {
      await current.close();
    }
  }
});

test("签名执行失败或补封印后仍无效时明确失败", options, async () => {
  for (const input of [{ signFails: true }, { corruptAfterSigning: true }]) {
    const current = await fixture({ kind: "adhoc", sealed: false, ...input });
    try {
      assert.throws(() => ensureMacosAppSeal(current.app, current.command));
    } finally {
      await current.close();
    }
  }
});

test(
  "补封印先逐个封嵌套 Mach-O（自内向外）再封外层 bundle",
  options,
  async () => {
    const deep =
      "Contents/Resources/app/process-helper/node_modules/node-pty/prebuilds/darwin-arm64/pty.node";
    const shallow = "Contents/Resources/app/node_modules/libnut.node";
    const current = await fixture(
      { kind: "unsigned", sealed: false },
      { nested: [shallow, deep] },
    );
    try {
      const result = ensureMacosAppSeal(current.app, current.command);
      assert.equal(result.repaired, true);
      assert.equal(result.nestedSigned, 2);
      const calls = (await current.read()).calls;
      // 逐文件先验（发现两个都没封）→ 外层验 → 判身份 → 深的先签 → 浅的后签 →
      // 重封外层 → 外层严格校验 → 再逐文件复验（这才允许放行）。
      assert.deepEqual(calls, [
        `verify:${shallow}`,
        `verify:${deep}`,
        "verify",
        "display",
        `sign:${deep}`,
        `sign:${shallow}`,
        "sign",
        "verify",
        `verify:${shallow}`,
        `verify:${deep}`,
      ]);
    } finally {
      await current.close();
    }
  },
);

test(
  "外层 --deep 校验通过但散装 Mach-O 未封印时仍逐个补封，最终失败数必须为 0",
  options,
  async () => {
    // CI 实测形态：外层 ad-hoc 封印有效（--deep 不覆盖 Resources 下的 .node），
    // 逐文件校验却有 4 个未封印。早退就是把这 4 个带着未封印发出去。
    const loose = "Contents/Resources/app/sidecar/spawn-helper";
    const current = await fixture(
      { kind: "adhoc", sealed: true },
      { nested: [loose] },
    );
    try {
      const result = ensureMacosAppSeal(current.app, current.command);
      assert.equal(result.repaired, true, "外层过了就不许早退");
      assert.equal(result.macho.failedTotal, 0, "验收口径是逐文件失败数为 0");
      const calls = (await current.read()).calls;
      assert.ok(
        calls.includes(`sign:${loose}`),
        "未封印的散装二进制必须被补封",
      );
      assert.ok(calls.includes("sign"), "补封内部后必须重封外层");
    } finally {
      await current.close();
    }
  },
);

test("外层是证书签名但内部未封印时拒绝 ad-hoc 降级", options, async () => {
  const current = await fixture(
    { kind: "developer-id", sealed: true },
    { nested: ["Contents/Resources/app/node_modules/libnut.node"] },
  );
  try {
    assert.throws(
      () => ensureMacosAppSeal(current.app, current.command),
      /原签名身份/,
      "Developer ID 包不能因为内部漏封就被 ad-hoc 重签，否则外层签名作废",
    );
    const calls = (await current.read()).calls;
    assert.ok(
      !calls.some((call) => call === "sign"),
      "拒绝降级时不得调用任何重签",
    );
  } finally {
    await current.close();
  }
});

test("嵌套二进制签不动时报错到具体文件，不假装封印完成", options, async () => {
  const current = await fixture(
    { kind: "unsigned", sealed: false, nestedFails: true },
    { nested: ["Contents/Resources/app/permissions.node"] },
  );
  try {
    assert.throws(
      () => ensureMacosAppSeal(current.app, current.command),
      /permissions\.node/,
      "报错要指到签不动的那个二进制，否则排查只能靠猜",
    );
    assert.equal((await current.read()).sealed, false, "不许把失败标成已封印");
  } finally {
    await current.close();
  }
});
