import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SandboxProcessScope as CodeExecutionScope } from "./types.js";

/** 探针只尝试创建自己的随机文件；隔离失效时也不覆盖用户文件。 */
export function readonlyProbe(scope: CodeExecutionScope) {
  const roots = [
    ...new Set([
      scope.rootDirectory,
      ...scope.additionalDirectories.map((entry) => entry.path),
    ]),
  ];
  const targets = roots.map((root) =>
    join(root, `.kenfutwork-readonly-${randomUUID()}`),
  );
  const program = `
const readonlyFailures=[];
for(const [root,target] of ${JSON.stringify(roots.map((root, index) => [root, targets[index]]))}) {
  try { fs.readdirSync(root); } catch(error) { readonlyFailures.push({root,read:error.code}); }
  let created=false;
  try {
    fs.writeFileSync(target,'readonly enforcement probe',{flag:'wx'});
    created=true;
    readonlyFailures.push({root,write:'allowed'});
  } catch(error) {
    if(!['EACCES','EPERM','EROFS'].includes(error.code)) readonlyFailures.push({root,write:error.code});
  } finally {
    if(created) { try { fs.unlinkSync(target); } catch {} }
  }
}`;
  return { program, targets };
}
