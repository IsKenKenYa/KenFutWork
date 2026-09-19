# 米家插件（kenfutwork-mihome）

把米家设备接进工作台：**侧栏面板**可看可控制，**agent** 也能直接操作。扫码登录一次，会话加密落库——服务端重启后不需要重扫。

## 安装

1. 插件市场 →「从链接安装」→ 填本机目录路径 `plugins/mihome`（或本仓库的 GitHub 子目录链接）。
2. 安装需要管理员；装完侧栏出现「米家」一行，点开即可扫码。

## 用法

- **面板**：侧栏「米家」→ 用米家 App 扫码 → 设备网格。开关类直接点，亮度类拖滑块，枚举类下拉，传感器只读显示；离线设备置灰。面板每 5 秒刷新一次属性值（设备列表缓存 5 分钟，顶部「刷新」可强制）。
  **二维码过期会自动换新码**（小米二维码约 2 分钟有效期，此前要手点「获取二维码」）；连换 20 次仍没人扫才停下来提示。
- **agent 工具**：
  - `mihome_devices`：列设备 + 每台设备可读写属性（含 `siid`/`piid` 与当前值）；
  - `mihome_control`：按 `did/siid/piid/value` 写入，返回**读回的真值**（米家云会接受指令但器件不响应，只报成功是假成功）。
  - 未连接时工具会明确报「请先打开面板扫码」，不会假装成功。

## 能力与接线

- 能力声明：`tools` + `routes` + `ui` + `storage`。
- 路由（私有，需登录）：`login/qr`、`login/poll`、`status`、`devices`、`control`、`disconnect`，
  面板经宿主 `postMessage` 拿到令牌后带 `Authorization` 调用。
- 会话（`mijia` 登录字段 + callback cookies + `ssecurity` + 设备标识）存在插件存储里：**按工作区隔离、值加密落库、HTTP 永不回显**；
  API 请求只带参考实现规定的 CookieJar（`cUserId`、两份 serviceToken、时区/地区、`PassportDeviceId`）；
  卸载插件会一并清空（重装需重新扫码），只「停用」则保留。
- 设备模型走 MIoT-Spec（`miot-spec.org`，匿名可读）：按属性类型 URN 的语义段判定开关/亮度/读数，
  不按品类写死；规格解析失败的设备如实显示「仅在线状态」，**不猜** `siid/piid`。

## 协议要点（都是真机踩出来的，改之前先读）

1. **登录 service 必须是 `mijia`**：先请求 `account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia`，
   把它返回的 `location` query 原样带进 `longPolling/loginUrl`，再轮询 `lp`、请求 callback 拿 `serviceToken`。
   旧版直接 `sid=xiaomiio` 出码会得到与现代家庭接口不匹配的会话；旧会话读取时自动清除，不伪装成已连接。
2. **API CookieJar 不是「所有 callback cookie 全塞进去」**：按参考实现固定写
   `cUserId`、两份 `serviceToken`、时区/夏令时、`channel=MI_APP_STORE`、国家、`PassportDeviceId`、`locale`。
   `deviceId/pass_o/passToken/userId/cUserId/uLocale` 只属于 serviceLogin 请求；二维码 callback 不手工带旧 Cookie。
3. **区域主机**：callback 的 STS URL 不是设备 API 主机；私有 RC4 API 只允许发往小米 `*.api.io.mi.com` 体系。
   未验证归属/授权用途的裸 `api.mijia.tech` **绝不发送 serviceToken、cookie、ssecurity 或 passToken**。
4. **空列表要如实解释**：现代 `mijia` 会话无效或账号/地区不对时，官方 API 可能只回空列表；面板显示
   「米家云没有返回家庭数据：请确认扫描的是绑定设备的米家账号，并确认账号地区与米家 App 一致」，不再把凭据发给第三方诊断域名。
5. **设备列表走家庭维度**：`/v2/homeroom/gethome_merged` 取 home_id/home_owner → 逐家庭
   `/home/home_device_list`（`limit`/`start_did`/`has_more` 分页）。经典 `/home/device_list` 只作
   「没有家庭模型的老账号」兜底。
5. **响应形态不对称**：成功体是 RC4 加密（可能 gzip），**错误体是明文 JSON**——解码顺序必须先试明文。

## 已知限制（如实）

1. **米家云是社区逆向的私有接口**（官方开放平台只对硬件厂商，没有面向个人的 API）：接口可能变更、有风控风险。
   登录只支持扫码——账密路径已被验证码/2FA 拦死。
2. 请求体按 RC4 加密路径（`rc4_hash__` + SHA1 签名 + 响应 RC4/gzip 解密）实现，算法照两个在线可用的
   参考实现复刻；**没有任何本地测试能替代真实账号的端到端验证**——首次接入请以「能否列出设备、开关是否真变」为准。
   本插件第一版就是在这里翻车：主机、cookie 罐、接口口径三处都错，靠真机逐步定位（详见《改造计划》§4.13 第十九轮）。
3. **旧二维码必须重扫一次**：旧版本使用错误的 `sid=xiaomiio`，它不是字段不全能补的问题——serviceToken
   绑定登录 service，不能迁移成 `mijia`。新版本读取到旧会话会自动清掉并回到未连接；请只扫新版本生成的码。
4. **凭据安全提示**：调试旧会话时，早期版本曾把该旧会话发到裸 `api.mijia.tech` 做一次确诊；公开证据只能证明
   同父域的特定子域被小米官方项目使用，不能证明该裸域获授权接收 serviceToken/cookies。当前代码已移除该路径，
   凭据只发给 `account.xiaomi.com` 与 `*.api.io.mi.com`。使用过早期诊断版的用户应在米家 App / 小米账号安全页
   撤销旧登录授权（若列表可见），并只扫描新 `sid=mijia` 二维码。
5. 面板是 `sidebar` 槽位的 iframe 弹层（插件 UI 缝的既有形态），不是常驻右栏标签。
5. 一次最多读 40 台设备的属性（云端按条心跳），设备多时面板顶部会如实标注只读了前 N 台。
6. 复杂品类（空调/扫地机等）按规格能力给控件：能给就给，给不了就只显示读数。
7. `mihome_control` 不在危险工具表里，默认档下不弹审批；要审批可在设置 → 权限 → 自定义里加规则。

## 开发

- **静态资源布局**：面板文件放在 bundle **根目录**（`panel.html` / `panel.js`），清单里的 `ui.url`
  写 `assets/panel.html`——这里的 `assets/` 是内核的 **HTTP 路由前缀**
  （`/api/plugins/<id>/assets/*`），文件路径是相对 bundle 根的（`readAsset` 的口径）。
  放成子目录 `assets/panel.html` 会 404，这是实测踩到的坑。
- 直接改本目录后**重启服务端**即生效（安装是把 bundle 拷到 `apps/server/.kenfutwork/plugins/` 下）；
  改清单（`package.json` 的 `ui`/`assets`）需要重新安装。
- 单测在宿主侧：`apps/server/src/features/plugins/mihome-plugin.test.ts`
  （纯函数 + 假米家云服务跑通 登录 → 设备 → 控制 全链路，并锁静态资源的路径口径）。
