# GitHub 安全告警核验与修复

核验日期：2026-10-22。读取用户提供的 [Dependabot](https://github.com/IsKenKenYa/KenFutWork/security/dependabot) 与 [代码扫描](https://github.com/IsKenKenYa/KenFutWork/security/code-scanning) 开放告警，共 7 项与 668 项。远端扫描提交与当前 `啃啃在开发` 工作区不同，判断以当前依赖和实际消费代码为准。原始告警与初始工作区记录保存在已忽略的 `.scratch/security-20261022/`。

## 依赖判断与处理

OSV 的 25 项报告包含重复、别名与停止维护通告。当前 npm 审计的 3 项高危、1 项中危集中在 `file-type`、`image-size`、`node-forge` 与 `braces`。本清单其余中危 CVE 已由现有版本覆盖。

| 包与公告 | 当前判断 | 处理 |
| --- | --- | --- |
| Vite：CVE-2026-112942、112943、112944 | Windows／WSL 编辑器启动的命令或参数注入；当前锁文件为 8.3.5，已超过 8.3.3 修复线 | 保留现有版本 |
| Hono：CVE-2026-111757；OSV 别名 CVE-2026-109955 | 静态路径重复解码绕过中间件；当前为修复版 4.13.11 | 保留现有 override |
| follow-redirects：CVE-2026-111755、111756 | 跨域重定向可能保留敏感请求头；当前为修复版 1.16.1 | 保留现有 override |
| postcss-selector-parser：CVE-2026-104844 | 公告标题包含 PostCSS，实际受影响包是 selector parser；当前为修复版 7.1.6 | 保留现有 override |
| linkify-it：CVE-2026-48801、59887 | 长文本处理可能耗尽 CPU；当前为修复版 5.0.2 | 保留现有 override |
| KaTeX：CVE-2026-103923（低危） | 当前为修复版 0.18.2 | 保留现有 override |
| file-type：CVE-2026-31808（中危） | 16.5.4 可被零长度 ASF 子对象触发持续循环；实际调用链为 nut-js → Jimp → file-type。21.x 改变 CommonJS 接口 | 在现用版本中拒绝小于固定 24 字节头的子对象，保留 `fromBuffer` 接口 |
| image-size：CVE-2025-71330（高危） | 0.7.5 可被零长度 ICNS 条目触发持续循环；当前仅由 appdmg 在构建时读取图片。2.x 改变旧回调接口 | 校验每个 ICNS 条目至少包含固定 8 字节头，保留 Buffer、文件路径和回调接口 |
| node-forge：CVE-2026-85393；OSV 保留旧编号 CVE-2026-33894 | 1.4.0 漏检签名 DigestAlgorithm 中的额外元素，库缺陷已复现。当前 sandbox-runtime 消费方用于生成证书，未发现该验签路径 | 采用上游 PR #1152 的嵌套元素数量检查，合法的有／无 NULL 参数签名继续接受 |
| braces：CVE-2026-93687（高危） | 3.0.3 的递归遍历存在过深输入问题，尚无修复发布。DeepAgents glob 接受运行时模式，调用方有异常处理，不能仅凭公告认定整个进程会终止 | 保留告警；未修改 glob 语法或增加未经设计的产品限制 |
| glib：RUSTSEC-2024-0429（中危，无 CVE） | 0.18.5 的 `VariantStrIter` 使用不正确的 FFI 输出指针，缺陷属实。属于 Tauri 的 Linux GTK 依赖；0.20 不能直接替代现有版本要求 | 保留告警；需要结合 Tauri／GTK 升级验证，增加另一个 glib 版本不能修复旧版本 |
| 其他 9 项 RUSTSEC | zvariant／zbus_names／zvariant_derive、unic 系列和 proc-macro-error 的停止维护通告 | 保留通告，不将其等同于已证实可利用的 CVE |

补丁依据：

- [file-type 上游修复](https://github.com/sindresorhus/file-type/commit/319abf871b50ba2fa221b4a7050059f1ae096f4f) 确认 ASF 的读取位置可能后退；本项目在减去固定头长度后立即拒绝非法对象。
- [image-size 官方公告](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) 描述 ICNS 条目长度为零时无法推进；本项目在每次读取条目头时校验长度，覆盖首条和后续条目。
- [node-forge 上游 PR #1152](https://github.com/digitalbazaar/forge/pull/1152) 当前尚未合并；采用其嵌套元素数量校验，并用真实签名构造验证非法额外元素被拒绝。

三项补丁通过 `pnpm.patchedDependencies` 和锁文件中的哈希分发。包版本保持原值，因此 npm audit、Dependabot 或 OSV 仍可能按版本报告它们。没有增加忽略规则，也没有将扫描数量解释为全部问题已经解决。

## 代码扫描的核验边界

668 项报告中，日志信息泄露 390 项、比较耗时 40 项、随机数相关 34 项、请求频率限制 66 项、正则耗时 32 项、OSV 25 项、其他规则 81 项。这些是规则命中记录，不能直接当成同等数量的已证实漏洞。

已核实的代表项：

- 图片代理的协议、主机边界和逐次重定向校验仍存在，保留已有 SSRF 修复。
- 两个宿主消息监听器均检查 `event.origin` 和实际 iframe 的 `event.source`。
- HA 与米家面板的当前 `el()` 使用 `textContent`；旧位置的 HTML 注入报告不能直接套用。
- OpenDesign `KEY_TO_FIELD` 中的 `embedSecret` 是字段映射名称，没有真实密钥。
- CORS 在来源精确匹配后才设置凭据响应头，未找到任意来源携带凭据的路径。
- `useCodingPlanProducts` 检查 `errors.aliyun.com` 的文字用于识别错误消息，不用于请求目标或访问授权。
- 浏览器正文提取、文档检查和 Mermaid 预算计算中的部分标签正则没有直接输出可执行 HTML，不能只因未覆盖全部 HTML 语法就认定存在 XSS。

日志中的原始 Error、供应商响应与 23 项多项式正则等尚未逐条确认；未把整类报告批量判为误报。服务为回环本机形态，有本机访问验证；本轮未加入改变并发或任务行为的新请求频率限制。

本轮修复 9 项指数级正则报告（代码扫描 #24—#32），涉及素材 Markdown、素材显示标签、插件标签与两处预览链接清理。普通字符分支不再与反斜杠转义重复匹配；两处预览共用同一个标点清理函数，匹配只从连续标点的起点开始。保留原有素材格式、转义、文件路径和结尾标点范围，未加入输入长度限制。

## 验证记录

使用仓库已有、经核验的 Node 24.22.1。依赖回归通过真实 Jimp、appdmg 与 node-forge 的解析路径运行：ASF／ICNS 输入在修复前无法结束，非法签名在修复前被接受；修复后同一组测试通过，并验证正常 PNG 解码、背景文件尺寸回调和合法签名。

正则回归编译并运行实际消费模块，以可终止的独立进程捕获同步阻塞。素材解析、显示标签、网址预览和文件链接四条路径在修复前分别超过 5 秒；修复后五条检查（另含插件标签）均正常结束，连同三项依赖回归共 8 项通过。

全量命令的结果与并行修改分别记录在本轮《日志》中。没有请求真实计费模型、操作用户 GUI、部署或修改远端告警状态。
