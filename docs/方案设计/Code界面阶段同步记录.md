# Code界面阶段同步记录

## 2026-10-04：固定UI分支与Task内核双亲合并

先按功能完成17批提交至`6e746f55`，再合并原UI固定`29fb8c09`；60处冲突按双方意图融合，保留原Root/主子SessionPane/品牌、资源删除与CanvasWorkbench提取，保留Task/Project UUID、固定Task根、权限与配置代际及终端/附件消费者。删除被terminal-api取代的code-git-api与旧panel-layout测试；第二settings/model config写面未复活。历史迁移均保留原字节。

合并后全量test（web449/server1866/shared90）、typecheck、Code/Design与Web/server构建、API生成和文档门禁通过；独占临时PG上compact FIFO、完整rewind、卸载及Controller/设置竞争5条通过，TaskWork迁移重放/no-op3条通过。3027项来源零漂移，Kimi登记源码逐项SHA验证；第一方改动安全format/import整理不改vendor字节。现存20项历史lint错误保持common base字节，未声明全lint通过。

这只证明合并与上述行为，未证明全部原UI操作/1:1视觉或Design完整回归。新引入默认skip的HTTP fixture仍有路径替UUID/旧Canvas/缺hello及外部DSN问题；下一切片改显式client与独占临时PG/random端口，再继续describe/list真实组件、队列/权限/结构化提问/子停止和历史编辑/分叉。权威施工清单仍见《Code内核实施交接》最新节，原UI交接的“主链已替换但未全部验收”结论保留。

## 第1阶段：原能力显隐、目录等待、URL模式

来源：`e58fe8ce029be5ea0462fdf9d6e8a3c599b05fe5`；以基线`65d1097ec398c0c8bb42f38816f4033a98ad109d`到来源提交的精确hunk同步，未整体cherry-pick。

- 原平台5项可选能力及原App/设置/侧栏/卡片守卫；未声明保持原行为，Code宿主仅声明实际接线。
- DirectoryBrowser等待项目绑定结果，失败保持选择器与可读错误；目录metadata仍走Human-only lane。
- SessionPane仅接自动化可用性守卫，保留Task附件预算与V4传输。
- 父工作台仅补Code/Design URL初始化和导航，Design/Flow主区逻辑保留；不接受裸Flow URL作为插件安装态。
- TaskWorkspaceRegistry、terminal activate/listeners、watcherId、Uint8Array、provider keyPresence/Native协议/模态及附件同键预算链保留。

验证：`pnpm --filter @zcode/shared build` exit0。单runner8文件首轮7文件21个用例通过、1个suite仅fixture共享包import无法解析；只修fixture import后该文件2个用例通过。累计23个用例通过，未重复broad。命令：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-cloud-capability.test.tsx test/code-cloud-settings-capability.test.tsx test/code-host-feature-capability.test.tsx test/code-directory-open.test.tsx test/workbench-modes.test.tsx test/code-host-channel.test.ts test/code-task-workspace.test.ts test/code-workbench-frame.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-host-feature-capability.test.tsx --maxWorkers=1
```

以下为源blob/SHA256；当前复制SHA由`docs/源码来源/ZCode源码清单.json`单处持有。

| 文件 | e58 source blob | e58 source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/App.tsx | 5bd6a6b2222d9a244b44edea31fba1cdb72ae10d | 5965100a3e79e89da85d93ea6ebb89f6c6b9800365a90274873ac3fcf514b3c0 |
| apps/web/src/components/workbench/zcode/ChatErrorBanner.tsx | 0f782c827a992dfb27b30dda77ed2a8b49ae1254 | bd5dd19b0d16329588ab5de2c4ca5cc74cfecd1493f9c84cff74dfa8947c21a6 |
| apps/web/src/components/workbench/zcode/SettingsPage.tsx | 904ccbeb282d4b7d1406d351803c9a47401c9bfd | d6faf56deabb98bb3f46380f7919f5c25b326f60ed72a0ba6a29fe137859a0bf |
| apps/web/src/components/workbench/zcode/WorkspaceSidebar.tsx | 32f8a06ee137cfd4d19123e0d1220cd26275233b | ba936a62ca192934c79092e0ce4d36ed2fb011bd4e2b5de5b2dede3fd2201c50 |
| apps/web/src/components/workbench/zcode/WorkspaceSidebarFooter.tsx | 00d61371f7f3c8e2c8d61e3da629818b44205c03 | d629e1a425137083914bb23793ec685f07d8faee02bd1b869781caacd4acc604 |
| apps/web/src/components/workbench/zcode/WorkspaceSidebarFooterUsageSummary.tsx | 7b3046f9e75676f1f51e4f1a992e61754884d3cf | 8d28e70c09d8153b310d40354865d4e5b512241c15b90fa3156f5951e40258a2 |
| apps/web/src/components/workbench/zcode/hooks/useCodingPlanEntryPlanList.ts | e44961d78053e8b780bfc506d8addc5ca4d89ada | b22fefe89b30c6a9e49c3f59d1f6975ce7f5272edcc305d4b0e36fff0620adef |
| apps/web/src/components/workbench/zcode/hooks/useRemoteConnectionEntryVisibility.ts | 63a6e5b6364563cd385cdae85d2bcffc71af3070 | 9d51bdbf9b04245952b26e043c9bbce859093aa535cd65461d762c43d3f3ab0e |
| apps/web/src/components/workbench/zcode/settings/CodingPlanEntryButton.tsx | 977ecef2f8b16c9bca9a1d7ff37fac4b172889b5 | 223a0265ad00f9bf4912dd0376d6749a88b90d703eff9d6a80c39b98c7ca3f70 |
| apps/web/src/components/workbench/zcode/settings/CodingPlanUpgradeDialogProvider.tsx | f8d40ebe33a79a5a283e4b03691ce1e0e8ea80c1 | f6af7a7786eb2cce3e970a7ce7d019862f472474e4e848135e19c96f66694ea2 |
| apps/web/src/components/workbench/zcode/settings/ModelProviderSection.tsx | a30fb44b22c1f9ed4e872b256012a484a2fa6797 | 8f25c623cccdb45f91cd85cee690e697319f8956d1cffe3ff77c3041d2ce3d17 |
| apps/web/src/components/workbench/zcode/settings/model-provider-section/useModelProviderNavigation.ts | fcbbf927546230bc32fca487206a0002bf028e92 | 7e55c1341ec8a9fdc69c9b2ad24df47ab9d2dff3bd9d2af999715d30c0f4dd9f |
| apps/web/src/components/workbench/zcode/settings/settingsPageConfig.ts | b8343e745289597440d8bba540db03f0d25f5da8 | cf9f15a59edbbe068d6510357f4645f8e3a769b5967994eb18f331d6f9ba5d55 |
| apps/web/src/components/workbench/zcode/lib/cuaPlatform.ts | 25b982e2ec5abcd0ba0e04743493c4e56d5893db | c815992e6b47e40d361ff72530cd8d1a2db795574998f12239716bf6786e4e1c |
| apps/web/src/components/workbench/zcode/DirectoryBrowser.tsx | 50b4a8a4adabf748dbebd96419129fa4d4f6f2fe | 597bc464509c2e2a4a4b2cb27385249fcc0d4adeb11e7f6cf1f20b1a56c649e3 |
| apps/web/src/components/workbench/zcode/root/useRootWorkspaceActions.ts | 011330d0feab04c17464e3d4cc4eddb1c774b943 | 8fbe3d73d30ca6037b2a7fccedf5b88294d3c88e004c1acc2aab68e75b315837 |
| apps/web/src/components/workbench/zcode/ToolCallBlocks/renderers/cron-create.tsx | f7eb278e10eae67c2e80456bcf25b5967ba85481 | 8dd18b0b803f0dc8cb9eab7a387dc7432cb3877e119948a0a0722cb0f050cdae |
| apps/web/src/components/workbench/zcode/ToolCallBlocks/renderers/offpeak-create.tsx | 01d81b41e8acebf0a91373f1db8d7204819ce5f4 | 584036baf8ff87e1b8dd333a0bc5043533f9c2b25f767d04dd450435ed656e7d |
| apps/web/src/components/workbench/zcode/v4/SessionPane.tsx | 3ce202afa3cd1e7b1cde1652f47c6e6451c6a7d6 | 231ebee6ecda8977d72bd81fafb36e357aa0aad58ef7b7837df4f58104a724c7 |
| packages/zcode-shared/src/platform.ts | 59ed9fef53f574ff6f42ca4f44f30ce339fb00fc | cce231dfeca3241f1a2ad8309fe7ab2118e54a5cf269421fa3fb976f9b158315 |
| apps/web/src/components/workbench/zcode/i18n/locales/en-US.ts | 8b57627e81470fac8b1e541c5778692856477386 | 044909e8dc6bf1ba1ce088af74b9837ac425e6267500d98d8cbf3ceacaecda30 |
| apps/web/src/components/workbench/zcode/i18n/locales/zh-CN.ts | 9abada12f0b957978bdff359d6b52b8ce68ebdfc | a8d064a8f5d673aaeed7fd85b6afc1ca5383eb4d7f894605195438830d1415ee |

## 第2阶段：Controller与通知恢复

来源仍冻结为`e58fe8ce029be5ea0462fdf9d6e8a3c599b05fe5`。沿用原SSE解析、hello恢复、模型视图刷新、Controller代理换代与原membership版本链；命令、终端写入和附件不重放。

- 主React树用`useSyncExternalStore`观察服务快照，原工作区服务注册同步换代。宿主`workspaceServiceController`经原RemoteWorkspaceSession/identity绑定链给可信source挂HTTP service attachment；原UI按identity识别服务目标的行为保持。
- `TaskWorkspaceRegistry`从真实Project DTO/Task meta建立Project UUID与固定根目录关联；`workspaceIdentity = JSON([ProjectUUID, fixedRoot])`仅作为公开索引键，客户端与服务端都不能从调用方字符串解码权限。
- 同目录项目必须有明确身份；path-only匹配出现歧义即不推测项目。刷新项目默认目录不能重绑旧Task。
- `onDynamicControllerFrame`与列表结果观察真实Task meta；`projectId`须由共享schema保留。动态终端/文件watcher仍按原精确ID过滤。
- 重连延迟消费服务端`ready.reconnectDelayMs`，缺省与护栏来自shared治理值。401/403停止恢复并拒绝挂起调用。
- 原hook恢复回归已按真实UUID、qualified identity与旧Task固定根目录适配；新测试另覆盖多次恢复、不重放、refs引用计数、同根身份隔离与CRLF分片。

验证：公开`windowHostControllerTaskFrameSchema.parse`先实际RED（Project UUID被strip，期望真实UUID却得到undefined），随后仅扩`zcodeTaskMetaSchema`的optional UUID字段并按拓扑build。单runner10文件首轮31 passed/1 failed；唯一失败暴露qualified identity缺原attachment，完成上述宿主接线及稳定fixture props后只复跑相关2文件，9 tests全部GREEN、exit0。命令与收据：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-host-controller-recovery.test.tsx --testNamePattern '公开Controller frame解析保留真实Project UUID' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts test/code-host-channel.test.ts test/code-task-workspace.test.ts test/code-directory-open.test.tsx test/code-host-feature-capability.test.tsx test/code-cloud-capability.test.tsx test/code-cloud-settings-capability.test.tsx test/workbench-modes.test.tsx test/code-workbench-frame.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts --maxWorkers=1
```

构建收据：`/private/tmp/kfw-code-controller-project-meta-build.log`；最后窄GREEN收据：`/private/tmp/kfw-code-client-recovery-current.log`。测试令牌已归还主任务，无live runner。

| 文件 | e58 source blob | e58 source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/host/httpChannelClient.ts | 632cb0c3dcf3c19431c050d2e0ab3c423e6b7929 | fad278de58b1f04de162610ccacd8da30146862f0cf0a6770c9b2f29d206a7cc |
| apps/web/src/components/workbench/zcode/host/main.tsx | 26c30be7e32d7fb4f0305364c9e6af5b95abedc0 | 2234e51aa28a445be86cd005640ef3943dcdf68f7c47583fc37305374f725170 |
| apps/web/src/components/workbench/zcode/host/workspaceServices.ts | 3f0b6a215d3b4d1bd55333b95b84512590e95311 | 89bb6a392ef02535323328f6f1b6cab4da801da5ac54f323ebba3cba3104e1d7 |
| apps/web/test/code-host-controller-recovery.test.tsx | 42cae050f5b6ea16d3d91850a584a37e9888f478 | bb88d2c0d84b57e5926684be62f52ba5886f27b1bf86fe1004c9682155bee91e |
| apps/web/test/setup/code-host-controller-http.ts | 1619b3844dbd4e77211cee9da0f8e8970052ec5b | 3e3f524586c0554868de01269d77ac6effab9f8c8862a59aaebb651242a1ccf0 |

## 第3阶段来源冻结与版权通知

第3阶段来源冻结为`92fad1ca182fcdd224d5f8f0c15ab4202d7b8754`，相对e58的前端增量包含原Root入口、平台能力守卫、默认目录与父文档reload恢复资格。该增量删除原自建宿主`WorkspaceHost`，其真实Project/固定Task根目录/new Task默认解析/viewer上下文已按下节收进必要宿主能力缝。

版权通知已独立按原字节同步：`apps/web/src/components/workbench/zcode/THIRD-PARTY-NOTICES.md`，1,978,939 bytes，保留原CRLF。冻结source与target SHA256均为`874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3`，与原来源清单记录一致。

## 第3阶段实施：直接挂原Root与完整身份消费

已按上述冻结范围同步原Root/能力守卫并直接接入`host/main.tsx`，原自建`WorkspaceHost`及重复provider树已移除。没有整体复制donor main，也未带回旧Canvas后台。

- `activateOrSetWorkspace`的可选canonical path/identity由真实Project DTO供给，原选择动作按该结果开tab/草稿；目录失败继续由原DirectoryBrowser保留重试与错误。
- `resolveNewTaskWorkspace`在原新任务动作前只读取最新Project默认；Ctrl+N进入B的新qualified草稿桶，旧Task UUID/固定A保持。同根邻Project的既有桶不被清空或合并。
- Root在layout阶段安装明确viewer上下文，子组件首次文件请求前生效；读取失败继续拒绝，不切到另一Project。原Human目录服务独立注入，选目录不走当前Task的file.resolvePath。
- 原`file.ensureConversationWorkspace`的真实additive DTO经共享schema验证后登记Project UUID，并仅附原UI可消费的opaque identity；原对话选择/草稿及默认兜底全部透传该identity。该链不创建Task/Canvas、不签执行scope。
- 原onboarding/云账号/导入/运行时偏好等能力按宿主实际安装态守卫，未声明的平台保持原行为；BYOK宿主仍不调用未接通的云服务。
- 新草稿应用逻辑从动作解析中提取，保留原pane/group reset、mention尾空格、预填与draft事实源；附件、terminal动态ID、watcher、Uint8Array、provider凭证presence与Controller恢复消费链保留。

producer范围说明：`ensureConversationWorkspace`完整DTO已由主任务/minimal实际RED到GREEN；`createDefaultWorkspace`与`createScratchWorkspace`尚未在此阶段声明完整DTO，也未提前改其返回契约。原scratch路径继续经canonical workspace.open绑定。

验证：原Root4个公开UI用例首轮4/4实际RED（云/引导请求及登录面）；完成启动/身份/context消费后单独取得Ctrl+N默认B实际RED（context仍A、期望B），再补默认解析。实际main接线及生产viewer helper、原草稿逻辑提取后，单runner9文件34 tests全部GREEN、exit0。`@zcode/ui typecheck`（vendor+host）与实际build均exit0。保留收据：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx --testNamePattern '原Root新建任务动作读取Project新默认B' --maxWorkers=1
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts test/code-host-channel.test.ts test/code-task-workspace.test.ts test/code-directory-open.test.tsx test/code-host-feature-capability.test.tsx test/code-cloud-settings-capability.test.tsx test/code-provider-credential.test.tsx --maxWorkers=1
```

日志：`/private/tmp/kfw-code-root-public-red.log`、`/private/tmp/kfw-code-root-default-public-red.log`、`/private/tmp/kfw-code-root-client-final-narrow.log`、`/private/tmp/kfw-code-root-ui-typecheck.log`、`/private/tmp/kfw-code-root-ui-build.log`。常规vendor chunk与jsdom canvas提示不影响退出状态。测试令牌已正式归还主任务，无live runner。

阶段3来源blob/SHA256如下；当前复制SHA与适配理由由`docs/源码来源/ZCode源码清单.json`持有。本阶段仅更新14个owned vendor记录，另保留validation必要optional Project UUID记录；其他并行修改记录未覆盖。

| 文件 | 92 source blob | 92 source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/Root.tsx | 3d6ba31f4cb5602181ce390b39036b1f4d68b5ab | 990afced028894f2f605337d17f5dbe71dd5f0533dcdbbaf9765e4d55f5f6e90 |
| apps/web/src/components/workbench/zcode/SettingsPage.tsx | d9cdb23ae327334145c3310aa65fa7593cb1e1e3 | f2f16d2c46ad559068e77638f684975bf6b0445bd2ebd3ca26910271b6a3b1b9 |
| apps/web/src/components/workbench/zcode/THIRD-PARTY-NOTICES.md | 64b78e5af1251f7c1519e857f57be7d53143c8d6 | 874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3 |
| apps/web/src/components/workbench/zcode/hooks/useDynamicWorkflowAvailability.ts | 68d7c810e584a0c7e2cad4b41aa9793804e71c0d | e91f0c96af43247e0ad7c709c40f722b882503ab86f0f022eabe2f877236e42c |
| apps/web/src/components/workbench/zcode/hooks/useOnboardingRecordService.ts | d1a84d6185655399d84b5a7830153b966af032cb | 3a9f883988b3e8e69a6b0e0ce9fbac5a420fc742b84a03f4652279505d2a65a8 |
| apps/web/src/components/workbench/zcode/host/main.tsx | 78c441c03d307a4f13a66d99dbc2d4b4dfdcaa3a | 9af5f15c4c01e01309b582c491b117e325e3a6c0781e332350a6d0a6e461b191 |
| apps/web/src/components/workbench/zcode/host/platform.ts | 33a820202279968e82b8bd26a243e595f78b0fe4 | b2f74db44af46c8db383fc42c392e326f4b6cdbc1107684fbbad7218af92f4db |
| apps/web/src/components/workbench/zcode/lib/rendererNavigation.ts | 80c788ab9cb5d058919bd9c52f27e7013548dac2 | d37b918a1c6bbfa05ed7792a63878e67471c8005cb3e6109bffa57e0363a4b1e |
| apps/web/src/components/workbench/zcode/onboarding/OccupationOnboarding.tsx | 32cde8adb57ef0e18ef7a7b3ea6bbb33bff2ef2b | dd327c588b9470fc46d6aad980beb1fbd2cb61234a13c01084c3597b286b480e |
| apps/web/src/components/workbench/zcode/root/types.ts | 4955946399e2be047ee0ea108aea77f270f7f10d | ab7d4fd930ebfa6adcab25d927e0fa94bd0d4d67e3eea90ce579888629bdd595 |
| apps/web/src/components/workbench/zcode/root/useAccountConnectionLossNotification.ts | db5f06742d63f903ee474a186cf50a45b4f08a26 | fc1e2d3e2a27ff79dba2b1cbdab59fb24674576619eec89abc0808fd458e0423 |
| apps/web/src/components/workbench/zcode/root/useRootOAuthEffects.ts | 40b3ace5e791cdde89841b21be8a33176b0b7705 | 6a2cc6740d4b778c80d1766a76dbd1f9b7cbce412c69601b3ed8627369d40dbd |
| apps/web/src/components/workbench/zcode/root/useRootWorkspaceActions.ts | b6db1188ebb53645751af0fd77cea46f6b53f5c7 | 28f72f153fd9a5954bfca7bd9e6dedd287f525ce9dff128d319c160228c779f1 |
| apps/web/src/components/workbench/zcode/settingsPageHelpers.tsx | a58433f6bd4fce3839f4c584bbff0d7dcd706bd3 | 60786f18381f9a4014f126f132d6bc99e00bd65e9188a83798a164fccf962e4c |
| apps/web/test/code-root-host.test.tsx | 28c9828c0fb4538febcdc71988a60fbbff749415 | c40a7fc360f6db9f63b64c35a813b1d23d45d8eb3e5c631dff493ab234510d1a |
| apps/web/test/setup/code-root-host-http.ts | af12715631c7d06ed278d01459d98f4d73be4f61 | b042819b1e5e49e07c8cb8836ed270a5b8bb1accfcd9cc5b9a5075eeefc5136e |
| packages/zcode-shared/src/platform.ts | 30a05361b1f77c0549da4a6d6726765b8615fe4a | a9441821ce8fdb426c575231278a2159b5898b73e737b948d177c4f03ea3c11f |

## 第4阶段：真实轻量标题与三创建消费完整

冻结来源：`3f5c38732f151fa64e99856f456623b303dbe14e`。该commit相对92实际包含14文件；本阶段仅同步原`useActiveTaskSnapshotMeta`、平台`sessionMetadataSource`及适配回归/来源记录，不带回donor后台、snapshot API或截图。

Code宿主声明`sessionMetadataSource: task-index`，原Root标题读取真实只读Task meta；未声明的平台保留原session snapshot投影。回归使用真实Task/Project UUID、qualified固定A与Project新默认B；缺失/删除不退回旧session读取，不初始化Task/Scope。服务端单Task点读与root-only/actor/project校验由主任务另行实际验证。

原三创建方法ensure/default/scratch统一经CodeUiWorkspace schema验证真实DTO后登记Project UUID，只附opaque identity给原消费方；不根据path/调用方qualified字符串伪造身份，不修改旧Task。Default/Scratch各自先实际公开IFile proxy RED（identity undefined），统一消费后6用例全GREEN。原UI没有createDefaultWorkspace call site，因此没有制造新空壳入口。

原Root标题首公开case实际RED（真实heading不存在），精确接线后title/缺省legacy/null/deleted 4/4 GREEN。平台源hunk因现有canonical/newTask适配冲突未整体应用，手工仅补metadata字段；原根目录/UUID/viewer缝保留。

最后单runner6文件31/31 GREEN、exit0；独立Code UI typecheck与实际build均exit0，令牌正式归还，无live runner。收据：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-session-metadata.test.tsx --testNamePattern '原Root主标题读取真实轻量元信息' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-workspace-creation.test.ts --testNamePattern 'createDefaultWorkspace消费真实canonical DTO' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-workspace-creation.test.ts --testNamePattern 'createScratchWorkspace消费真实canonical DTO' --maxWorkers=1
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx test/code-session-metadata.test.tsx test/code-workspace-creation.test.ts test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts test/code-host-channel.test.ts --maxWorkers=1
```

日志：`/private/tmp/kfw-code-session-metadata-public-red.log`、`/private/tmp/kfw-code-session-metadata-green.log`、`/private/tmp/kfw-code-workspace-default-consumer-red.log`、`/private/tmp/kfw-code-workspace-scratch-consumer-red.log`、`/private/tmp/kfw-code-workspace-consumers-green.log`、`/private/tmp/kfw-code-metadata-creation-final-narrow.log`、`/private/tmp/kfw-code-metadata-creation-ui-typecheck.log`、`/private/tmp/kfw-code-metadata-creation-ui-build.log`。

| 原vendor文件 | 3f source blob | 3f source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/hooks/useActiveTaskSnapshotMeta.ts | 73032d01fb51c51862e021232c6101fa254a28fd | ffb36d0e0abd8665458a818256c56da0b3b30b4d5d1d005260e695e89cb1e8d7 |
| packages/zcode-shared/src/platform.ts | 168c98a39a54362457a0c9572445c957def593b8 | f2623badafecaf4eb3d9c23507f22017f40dc6ee6ddcf73d075fa7c0f6189c7c |
| packages/zcode-services/src/file/file.ts | ea5f6c67753c63a30249d4ed9fcca244ae7e9f6b | 9cd8de18048a2834cbba5da953a568012f58cc47191b9bad85e7b292ac07a0a9 |

第一方platform source blob为`c362472d08f5c591b8df194d71f16a6dd4be898d`，source SHA256为`37768d5facd5c3a19006138cb04ca9d9e902cf342e1192a7d178cfa8f2c77dee`。原外部browser夹具按字节复用，source/target SHA256均为`a832fe72cdb4aa434e4b289e4afd5d8c9db4fafc504896c5d6f7aa604e6097f4`。

## 第5阶段：原生文件提交到原工具卡的真实补丁展示

第一方native Write/Edit从真实`FileCommit.structuredPatch`产生`file_diff`，ApplyPatch只从实际提交的`result.files`产生`file_diffs`。完整canonical提交与modelContent保持独立；bridge artifact保留display，原公开生命周期只克隆用于事件的ToolMessage，由既有Harness stream进入原V4投影。部分ApplyPatch已提交的文件保留真实diff，失败项不伪造diff，公开行状态如实为error。

原`ToolOutput`结果display联合复用原单文件schema补齐`file_diffs`；row顶层display联合保持原契约。第一次真实公开Edit RED为事件未携带display，多文件解析另取得file_diffs被strip的实际RED；接线后原`toolCallRowToLegacyNode`与原summary消费真实结果，文件按钮实际打开patch详情。该阶段未修改runtime/deep-agent/stream-adapter生产循环。

展示预算读取Task文件域`codePatchMaxBytes`，仅保留完整hunk，真实总增删计数不因预览截断而缩水，也不修改canonical补丁。最小shared治理预算下，真实Edit一次提交两个非相邻hunk，公开预览仅保留一个。截断case首RED明确原summary丢失truncated；随后只补原摘要optional字段、原卡可见提示及中英文文案，卡片收起时也明确说明仅展示部分变更。没有制造加载完整详情按钮。

最终公开文件链单runner4/4 GREEN，涵盖真实Edit完整提交、ApplyPatch部分提交、原结果schema及截断原UI消费；服务端4文件26/26 GREEN。Code UI vendor/host typecheck与实际build均exit0。该阶段较早server typecheck收据仅记录同期OpenAPI三项worktree schema导出缺失，属主任务并行范围；最终server全量门禁由主任务收口。验证命令：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-file-display-public.test.tsx --testNamePattern '真实Edit完整提交但预览受Task预算截断时' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-file-display-public.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/server exec vitest run src/features/code-tools/file-display.test.ts src/features/code-tools/tool-definitions.test.ts src/agent/kernel-tools-bridge.test.ts src/features/code-ui/tool-lifecycle.test.ts --maxWorkers=1
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
```

收据：`/private/tmp/kfw-code-file-display-public-red.log`、`/private/tmp/kfw-code-file-diffs-schema-public-red.log`、`/private/tmp/kfw-code-file-display-truncated-red.log`、`/private/tmp/kfw-code-file-display-public-current.log`、`/private/tmp/kfw-code-file-display-server-current.log`、`/private/tmp/kfw-code-file-display-server-typecheck.log`、`/private/tmp/kfw-code-file-display-ui-typecheck.log`、`/private/tmp/kfw-code-file-display-ui-build.log`。首截断GREEN运行只因夹具使用未配置的jest-dom matcher而失败，改为原vitest文本断言后4case全通过。jsdom canvas提示与vendor chunk大小提示未改变成功退出状态。唯一测试令牌已正式归还主任务，无live runner。

来源清单只更新本阶段6个owned vendor记录：toolDisplay、fileSummaries、fileSummaryTypes、edit renderer与两种locale。原source revision/blob与既有locale donor syncSource保留；使用原checkout只读Git对象核对source SHA、donor SHA及当前target copiedSha，6项全部一致。工作树未初始化references子模块，也未复制或建立符号链接。owned paths的`git diff --check`通过；全仓diff中`THIRD-PARTY-NOTICES.md`的原CRLF字节保真例外保留，未为清除trailing whitespace修改版权原字节。

后续V4文件详情必须从已持久事件的完整canonical/journal聚合真实提交，不从有界display还原完整补丁。单Write/Edit canonical带解码`originalFile`与`content`，ApplyPatch files仅有path/type/structuredPatch/counts/version；恢复原字节必须使用真实checkpoint/ledger。Git只保存可执行位，材料化文件mode不代表完整原权限：现存文件保留最终native实际观察mode；已删除文件恢复为owner读写`0600`，仅继承Git保存的owner执行位，执行文件为`0700`。这些POSIX位是权限语义常量，不是运行时限额，不另造完整mode元数据历史。真实`0600` Edit回退首RED为权限扩大到`0644`；修正后19个文件回退边界用例全GREEN，收据为`/private/tmp/kfw-file-rewind-mode-red.log`与`/private/tmp/kfw-file-rewind-boundaries.log`。已删可执行文件`0700`与完成顺序也已回归；后者实际RED暴露按启动行顺序重建会误拒绝合法提交，改为持久completion日志顺序后GREEN，收据为`/private/tmp/kfw-file-rewind-completion-order-red.log`。原V4 RPC独立PG/Scope/Checkpoint/ShadowGitExec/SRT正例1/1 GREEN，UTF16/BOM、`0600`、cold聊天/reverted摘要、旧CAS duplicate与新代际已验证，收据为`/private/tmp/kfw-file-rewind-v4-current.log`。delete.version是删除前版本；move的filePath是源路径、movePath是目标路径、version为目标提交后版本，patch来自目标新建；移动目标已提交但源未删的partial结果如实为目标add加failure，不得冒充成功move。
