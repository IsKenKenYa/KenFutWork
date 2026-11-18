/**
 * 测试专用的「用 node 跑一段程序」命令行构造器。
 *
 * 沙箱的执行外壳按宿主方言不同，同一段程序要拼成不同形态：POSIX 侧外壳是 `sh`，单引号
 * 包裹即可；Windows 侧默认落 PowerShell（`process-sandbox/windows-broker.ts` 的默认解析），
 * 它有两个坑——带引号的程序路径必须加调用算子 `&`，且 `-Command` 会吞掉内嵌双引号（本机
 * 实测），所以整段改用 PowerShell 单引号字符串（内部 `'` 翻倍）、路径用正斜杠。
 *
 * 用法：`nodeCommand(program)` 里的 `program` 一律用 **JS 单引号**写字符串字面量，路径用
 * `slashPath()`，这样两个方言都不需要转义双引号。
 */
const posixQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
const powershellQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** 把 Windows 反斜杠路径转成两个方言都认的正斜杠形式。 */
export function slashPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function nodeCommand(program: string): string {
  if (process.platform !== "win32") {
    return `${posixQuote(process.execPath)} -e ${posixQuote(program)}`;
  }
  return `& ${powershellQuote(process.execPath)} -e ${powershellQuote(program)}`;
}
