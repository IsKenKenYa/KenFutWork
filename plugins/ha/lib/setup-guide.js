/**
 * 面板「接入引导」的步骤数据（纯数据，无逻辑）：未配置态按教程里 HA 集成流程的形状
 * 组织——「选择品牌或集成」两张默认品牌卡（米家/华为，即插件默认支持的两个生态，
 * 默认展开）+ 通用步骤（部署 HA → 装 HACS → 允许内嵌 → 建长期令牌）。
 *
 * 事实核对（2026-10-24，逐条对官方来源；2026-10-25 补教程里的 OAuth 跳转地址坑）：
 * - Docker 部署命令与镜像名：home-assistant.io/installation（与插件 README 验收配方同款）。
 * - HACS 容器安装：hacs.xyz「Download」文档——`docker exec -it <容器> bash` 后
 *   `wget -O - https://get.hacs.xyz | bash -`，装完重启 HA；**HA 2026.11 起商店内置**，
 *   到那版的用户可跳过这一步。
 * - 米家：小米官方集成 `XiaoMi/ha_xiaomi_home` 已在 HACS 默认源（搜「Xiaomi Home」），
 *   登录是小米账号 OAuth（支持中国大陆区）；授权最常见的翻车点是 OAuth2 认证跳转地址里的
 *   `homeassistant.local` 解析不了（教程与集成 README 同口径）：把它换成 HA 的局域网 IP。
 *   社区替代 `al-one/hass-xiaomi-miot` 不默认推荐。
 * - 华为：`xiasi0/ha-huawei-smarthome` **不在 HACS 默认源**，要先加「自定义仓库」；
 *   登录 = 华为账号 + 密码 + 挑战码（推送到已登录华为设备），再选家庭；设备按 `prodId`
 *   逐产品适配，无适配器 = HA 里没有该实体。
 * - 内嵌（2026-10-24 用户拍板「要教程里一样的界面」→ 面板默认显示 HA 原生前端）：
 *   HA 默认发 `X-Frame-Options` 挡内嵌。新版（≥ 2026.8）在「设置 → 系统 → 网络」
 *   关闭「Send X-Frame-Options」；旧版用 configuration.yaml 的
 *   `http.use_x_frame_options: false`（http 官方文档：该块已迁移到 UI，YAML 会触发
 *   弃用修复提示）。
 *
 * 这是数据不是代码：改步骤内容只改本文件；面板经 `guide` 路由取这一份，测试锁死仓库
 * 链接与关键命令（装错仓库是引导最大的事故面）。
 */

/**
 * @typedef {Object} GuideItem
 * @property {"text"|"command"|"link"} kind
 * @property {string} [text] kind=text/command 时的内容
 * @property {string} [label] kind=link 的显示名 / command 的复制按钮旁标签
 * @property {string} [url] kind=link 的目标地址
 */

/**
 * @typedef {Object} GuideBrand
 * @property {"xiaomi"|"huawei"} id 稳定标识（面板按它给图标着色）
 * @property {string} title 品牌名（界面标签）
 * @property {string} subtitle 一行说明：集成来源与登录方式
 * @property {boolean} open 默认展开——两个默认生态都展开（拍板口径）
 * @property {GuideItem[]} items
 */

/**
 * @typedef {Object} GuideStep
 * @property {string} id 稳定标识
 * @property {string} title 步骤标题（界面标签，不写句子）
 * @property {boolean} open 默认是否展开——通用步骤都收起，品牌卡才是主角
 * @property {GuideItem[]} items
 */

/** 默认支持的两个生态品牌卡（顺序即面板展示顺序，都在 HACS 之外可跳转核源）。 */
export const SETUP_GUIDE_BRANDS = [
  {
    id: "xiaomi",
    title: "米家",
    subtitle: "小米官方集成 · OAuth 登录",
    open: true,
    items: [
      { kind: "text", text: "HACS 搜索「Xiaomi Home」并下载" },
      {
        kind: "text",
        text: "重启 HA → 设置 → 设备与服务 → 添加集成 → Xiaomi Home",
      },
      { kind: "text", text: "登录地区选中国大陆，点登录链接完成小米账号授权" },
      {
        kind: "text",
        text: "授权报错：把 OAuth2 认证跳转地址里的 homeassistant.local 换成 HA 的局域网 IP",
      },
      {
        kind: "link",
        label: "小米官方集成",
        url: "https://github.com/XiaoMi/ha_xiaomi_home",
      },
    ],
  },
  {
    id: "huawei",
    title: "华为（HUAWEI HiLink）",
    subtitle: "社区集成 · 账号 + 挑战码",
    open: true,
    items: [
      {
        kind: "text",
        text: "HACS 右上角「⋯」→ 自定义仓库（类别选「集成」）",
      },
      {
        kind: "link",
        label: "华为集成仓库",
        url: "https://github.com/xiasi0/ha-huawei-smarthome",
      },
      { kind: "text", text: "搜索「Huawei SmartHome」下载并重启 HA" },
      {
        kind: "text",
        text: "添加集成 → 华为账号 + 密码 + 挑战码（推送到已登录的华为设备）→ 选择家庭",
      },
      { kind: "text", text: "按产品适配：无适配器的设备不会出现在 HA" },
      {
        kind: "link",
        label: "已支持设备清单",
        url: "https://github.com/xiasi0/ha-huawei-smarthome/blob/main/docs/supported-devices.md",
      },
    ],
  },
];

/** 通用步骤（两个品牌共用的前置与收尾，默认收起）。 */
export const SETUP_GUIDE_STEPS = [
  {
    id: "ha",
    title: "安装 Home Assistant",
    open: false,
    items: [
      { kind: "text", text: "已有 HA 可跳过" },
      {
        kind: "command",
        label: "Docker 部署",
        text: "docker run -d --name ha -p 8123:8123 -v ha_config:/config ghcr.io/home-assistant/home-assistant:stable",
      },
      { kind: "text", text: "打开 http://<HA 地址>:8123 完成初始化" },
      {
        kind: "link",
        label: "官方安装文档",
        url: "https://www.home-assistant.io/installation/",
      },
    ],
  },
  {
    id: "hacs",
    title: "安装 HACS 应用市场",
    open: false,
    items: [
      { kind: "text", text: "HA ≥ 2026.11 自带商店可跳过" },
      { kind: "command", label: "进容器", text: "docker exec -it ha bash" },
      {
        kind: "command",
        label: "下载 HACS",
        text: "wget -O - https://get.hacs.xyz | bash -",
      },
      {
        kind: "text",
        text: "重启 HA → 设置 → 设备与服务 → 添加集成 → HACS（登录 GitHub）",
      },
      {
        kind: "link",
        label: "HACS 官方文档",
        url: "https://www.hacs.xyz/docs/use/download/download/",
      },
    ],
  },
  {
    id: "embed",
    title: "允许面板内嵌 HA 界面",
    open: false,
    items: [
      {
        kind: "text",
        text: "HA「设置 → 系统 → 网络」关闭「Send X-Frame-Options」",
      },
      {
        kind: "text",
        text: "旧版 HA 在 configuration.yaml 加入并重启：",
      },
      {
        kind: "command",
        label: "configuration.yaml",
        text: "http:\n  use_x_frame_options: false",
      },
      {
        kind: "link",
        label: "HA 网络设置文档",
        url: "https://www.home-assistant.io/integrations/http/",
      },
    ],
  },
  {
    id: "token",
    title: "创建长期令牌",
    open: false,
    items: [
      { kind: "text", text: "HA「个人资料 → 安全」创建长期访问令牌" },
      { kind: "text", text: "地址与令牌填进下方「连接」表单" },
    ],
  },
];
