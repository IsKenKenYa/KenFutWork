import { resolveTerminalFontProfile } from "@zcode/services/terminal-profile";
import type { AppSettings } from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeTerminalService, TerminalSubscriber } from "./types.js";

const identity = z.object({ id: z.string().min(1) });
const size = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
});
const create = size.extend({
  taskId: z.string().uuid(),
  cwd: z.string().optional(),
});
const input = identity.extend({ data: z.string() });
const resize = identity.merge(size);

export async function codeUiTerminalRpc(deps: {
  terminals: CodeTerminalService;
  actor: LocalActor;
  connectionId: string;
  method: string;
  args: unknown[];
  subscriber: (id: string) => TerminalSubscriber;
  preferences?: Pick<
    AppSettings,
    "terminalFontFamily" | "terminalInheritSystemProfile"
  >;
}): Promise<{ result: unknown } | null> {
  const { actor, connectionId, terminals } = deps;
  switch (deps.method) {
    case "create": {
      const opened = await terminals.create(
        actor,
        connectionId,
        create.parse(deps.args[0]),
      );
      const profile = resolveTerminalFontProfile({
        settings: deps.preferences ?? {},
      });
      return {
        result: {
          id: opened.id,
          shell: opened.executable,
          fontFamily: profile.fontFamily,
          fontFamilySource: profile.source,
          ...(profile.fontSize === undefined
            ? {}
            : { fontSize: profile.fontSize }),
          ...(profile.theme ? { theme: profile.theme } : {}),
        },
      };
    }
    case "activate": {
      const { id } = identity.parse(deps.args[0]);
      await terminals.subscribe(actor, connectionId, id, deps.subscriber(id));
      return { result: null };
    }
    case "write": {
      const { id, data } = input.parse(deps.args[0]);
      await terminals.write(actor, connectionId, id, data);
      return { result: null };
    }
    case "resize": {
      const { id, cols, rows } = resize.parse(deps.args[0]);
      await terminals.resize(actor, connectionId, id, cols, rows);
      return { result: null };
    }
    case "dispose": {
      const { id } = identity.parse(deps.args[0]);
      await terminals.stop(actor, connectionId, id, "客户端关闭终端");
      return { result: null };
    }
    default:
      return null;
  }
}
