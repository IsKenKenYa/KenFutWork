import {
  Blocks,
  Bot,
  FileText,
  Globe,
  ListTodo,
  type LucideIcon,
  Package,
  Palette,
  Pencil,
  Search,
  SquareTerminal,
  Video,
  Wrench,
} from "lucide-react";

import type { TaskToolEntry } from "@/lib/workbench-tools";

/**
 * 工具行的类型图标（ZCode 同款口径：每类工具一个语义图标，16px、次级灰，
 * 无彩色无每类换色——彩色状态点已经够多了，图标只承担「一眼认出动作类型」）。
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  execute: SquareTerminal,
  edit_file: Pencil,
  write_file: Pencil,
  read_file: FileText,
  grep: Search,
  glob: Search,
  project_search: Search,
  web_search: Globe,
  fetch: Globe,
  write_todos: ListTodo,
  task: Bot,
  generate_image: Palette,
  screenshot_canvas: Palette,
  manipulate_canvas: Palette,
  inspect_canvas: FileText,
  video_generate: Video,
  get_brand_kit: Package,
  list_skills: Blocks,
};

export function toolIcon(tool: TaskToolEntry): LucideIcon {
  return TOOL_ICONS[tool.toolName] ?? Wrench;
}
