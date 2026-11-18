# kenfutwork-example-clock

KenFutWork 参考插件：演示一个**双端兼容**的插件 bundle。

同一份产物同时声明 `dsh.bundle`（deepseek-harness）与 `loomic.bundle`，
两边的装载形状都是 `{ name, inject, apply(ctx) }`，所以不需要转换步骤。

## 结构

```
example-clock/
├── package.json       # 双声明：dsh.bundle + loomic.bundle → ./cordis.patch.yml
├── cordis.patch.yml   # 配置层：insert 一行，name 指向包名（靠 Node 解析）
└── index.js           # 插件模块：导出 name / inject / apply
```

## 能力声明

- `tools` — 向宿主工具注册表贡献 `clock_now`

KenFutWork 侧支持的能力面见 `apps/server/src/features/plugins/capability-binding.ts`；
不在该表内（或标记为不支持）的能力会让安装被兼容性门禁拦下。

## 安装

KenFutWork：在插件市场「从链接安装」里填本目录路径，先校验再安装。

deepseek-harness：

```sh
dsh plugin --profile <profile> add ./plugins/example-clock
```

## 说明

`index.js` 用 dsh 的 ContentBlock 形状返回结果（`{ content: [...] }`）；
KenFutWork 的适配层会优先取 `structuredContent`，否则取文本块。
