/**
 * 面板「接入引导」的步骤数据（纯数据，无逻辑）：把「部署 HA → 装 HACS → 接米家 →
 * 接华为 → 建长期令牌」做成插件自己的引导界面，用户不必再去翻外部教程。
 *
 * 事实核对（2026-10-24，逐条对官方来源）：
 * - Docker 部署命令与镜像名：home-assistant.io/installation（与插件 README 验收配方同款）。
 * - HACS 容器安装：hacs.xyz「Download」文档——`docker exec -it <容器> bash` 后
 *   `wget -O - https://get.hacs.xyz | bash -`，装完重启 HA；**HA 2026.11 起商店内置**，
 *   到那版的用户可跳过这一步。
 * - 米家：小米官方集成 `XiaoMi/ha_xiaomi_home` 已在 HACS 默认源（搜「Xiaomi Home」），
 *   登录是小米账号 OAuth（支持中国大陆区）；社区替代 `al-one/hass-xiaomi-miot` 不默认推荐。
 * - 华为：`xiasi0/ha-huawei-smarthome` **不在 HACS 默认源**，要先加「自定义仓库」；
 *   登录 = 华为账号 + 密码 + 挑战码（推送到已登录华为设备），再选家庭；设备按 `prodId`
 *   逐产品适配，无适配器 = HA 里没有该实体。
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
 * @typedef {Object} GuideStep
 * @property {string} id 稳定标识（米家/华为两个步骤的面板默认展开逻辑靠它）
 * @property {string} title 步骤标题（界面标签，不写句子）
 * @property {boolean} open 默认是否展开——米家/华为两个生态默认展开
 * @property {GuideItem[]} items
 */

/** 默认支持并默认展开引导的两个生态步骤。 */
export const GUIDE_OPEN_STEP_IDS = ["xiaomi", "huawei"];

/** @type {GuideStep[]} */
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
    id: "xiaomi",
    title: "接入米家",
    open: true,
    items: [
      { kind: "text", text: "HACS 搜索「Xiaomi Home」并下载" },
      {
        kind: "text",
        text: "重启 HA → 设置 → 设备与服务 → 添加集成 → Xiaomi Home",
      },
      { kind: "text", text: "点登录链接用小米账号授权（区域选中国大陆）" },
      {
        kind: "link",
        label: "小米官方集成",
        url: "https://github.com/XiaoMi/ha_xiaomi_home",
      },
    ],
  },
  {
    id: "huawei",
    title: "接入华为",
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
