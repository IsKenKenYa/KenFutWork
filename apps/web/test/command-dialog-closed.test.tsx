import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Command,
  CommandDialog,
  CommandInput,
} from "../src/components/workbench/zcode/components/ui/command.js";

describe("CommandDialog", () => {
  it("关闭态不把标题与描述留在文档里", () => {
    render(
      <CommandDialog open={false} title="命令面板" description="搜索命令">
        <Command>
          <CommandInput placeholder="搜索" />
        </Command>
      </CommandDialog>,
    );

    expect(screen.queryByText("命令面板")).toBeNull();
    expect(screen.queryByText("搜索命令")).toBeNull();
  });
});
