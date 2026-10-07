import type { ReadCursor } from "./file-types.js";

export interface CodeProjectContextLimits {
  maxTextBytes: number;
  maxEntries: number;
}
export interface CodeProjectInstruction {
  path: string;
  scopeDirectory: string;
  content: string;
  truncated: boolean;
  continuation?: ReadCursor;
}
export interface CodeProjectInstructions {
  instructions: CodeProjectInstruction[];
  truncated: boolean;
}
export interface CodeProjectSkill {
  name: string;
  description: string;
  path: string;
  /** Local resources are read on demand through Read, never preloaded. */
  files: [];
}
export interface CodeProjectContext extends CodeProjectInstructions {
  skills: CodeProjectSkill[];
  issues: Array<{ path: string; message: string }>;
}
