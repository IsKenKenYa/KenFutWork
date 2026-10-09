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
if(target!==APP){
 state.calls.push('sign:'+path.relative(APP,target));
 save();process.exit(state.nestedFails?1:0);
}
if(args.includes('--verify')){state.calls.push('verify');save();process.exit(state.sealed?0:1);}
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
    const current = await fixture(
      { kind: "unsigned", sealed: false },
      {
        nested: [
          "Contents/Resources/app/node_modules/libnut.node",
          "Contents/Resources/app/process-helper/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
        ],
      },
    );
    try {
      const result = ensureMacosAppSeal(current.app, current.command);
      assert.equal(result.repaired, true);
      assert.equal(result.nestedSigned, 2);
      assert.deepEqual((await current.read()).calls, [
        "verify",
        "display",
        // 深的先签：先 prebuilds 里的 pty.node，再浅一层的 libnut.node
        "sign:Contents/Resources/app/process-helper/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
        "sign:Contents/Resources/app/node_modules/libnut.node",
        "sign",
        "verify",
      ]);
    } finally {
      await current.close();
    }
  },
);

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
