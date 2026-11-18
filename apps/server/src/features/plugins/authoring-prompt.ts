import type { PromptSectionDefinition } from "../../kernel/types.js";

export const pluginAuthoringPromptSection: PromptSectionDefinition = {
  name: "plugins.authoring",
  scope: "always",
  order: 80,
  resolve: () => `## 技能、插件与 MCP 制作
仅在用户需要这些交付物时使用以下指导，按任务选择工具与技能。
- 使用 ToolSearch 查找 create_skill、install_plugin、create_mcp_server 等实际可用工具，并读取其参数要求；工具发现不授予执行权限。
- 技能由 SKILL.md 和同目录资源组成，YAML frontmatter 包含 name、description。按交付要求使用 create_skill 发布，content 提供完整 SKILL.md，附属文件通过工具的 files 参数提交。
- 插件 bundle 包含 package.json、cordis.patch.yml 和 ESM index.js。package.json 使用 {"kenfutwork":{"bundle":{"patch":"./cordis.patch.yml"}}} 声明补丁文件，并声明 type、main；补丁中的 insert 使用数组。参考已安装开发技能和实际宿主接口，在 Task 授权目录中编写产物，再按交付要求使用 install_plugin 安装并检查真实结果。
- MCP stdio 脚本写入 Task 授权目录，通过 create_mcp_server 的实际参数注册；安装和移除连接沿用 Task 生命周期与归属检查。
- 生成文件、发布技能、安装插件、启用能力和启动进程分别遵守当前 Plan、角色、目录和审批。制作插件不会扩大当前权限；保留已有文件并说明检查或安装失败的具体原因。`,
};
