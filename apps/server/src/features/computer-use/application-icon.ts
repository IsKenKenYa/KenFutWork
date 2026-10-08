import type { ApplicationIconInfo } from "@zcode/shared";
import { z } from "zod";
import { readPngWithinBudget } from "./budget.js";
import { runJxa } from "./jxa.js";

const bundleId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const requestSchema = z.union([
  bundleId.transform((value) => [{ kind: "darwin-bundle-id" as const, value }]),
  z
    .object({
      locators: z
        .array(
          z.discriminatedUnion("kind", [
            z
              .object({ kind: z.literal("darwin-bundle-id"), value: bundleId })
              .strict(),
            z
              .object({
                kind: z.enum(["windows-executable-path", "windows-aumid"]),
                value: z.string().min(1),
              })
              .strict(),
          ]),
        )
        .max(3),
    })
    .strict()
    .transform((request) => request.locators),
]);

export interface ApplicationIconResolver {
  read(
    request: unknown,
    context: { signal: AbortSignal; timeoutMs: number; maxBytes: number },
  ): Promise<ApplicationIconInfo | null>;
}

/** 仅按系统应用标识查询已安装应用；不接受模型/客户端指定的本机文件路径。 */
export function createMacosApplicationIconResolver(): ApplicationIconResolver {
  return {
    async read(request, context) {
      const ids = requestSchema
        .parse(request)
        .filter((locator) => locator.kind === "darwin-bundle-id")
        .map((locator) => locator.value);
      if (!ids.length) return null;
      const raw = await runJxa(
        `ObjC.import('AppKit');
const workspace=$.NSWorkspace.sharedWorkspace, ids=${JSON.stringify(ids)};
let result=null;
for(const id of ids) {
  const url=workspace.URLForApplicationWithBundleIdentifier($(id));
  if(url.isNil()) continue;
  const icon=workspace.iconForFile(url.path);
  const bitmap=$.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null,32,32,8,4,true,false,$.NSDeviceRGBColorSpace,0,0);
  const graphics=$.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
  $.NSGraphicsContext.saveGraphicsState;
  try {
    $.NSGraphicsContext.setCurrentContext(graphics);
    icon.drawInRectFromRectOperationFraction($.NSMakeRect(0,0,32,32),$.NSMakeRect(0,0,0,0),$.NSCompositingOperationCopy,1);
  } finally { $.NSGraphicsContext.restoreGraphicsState; }
  const png=bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({}));
  result={data:ObjC.unwrap(png.base64EncodedStringWithOptions(0))};
  break;
}
JSON.stringify(result);`,
        context.timeoutMs,
        context.signal,
        context.maxBytes,
      );
      const parsed = z
        .object({ data: z.string().min(1) })
        .nullable()
        .parse(raw);
      if (!parsed) return null;
      const bytes = Buffer.from(parsed.data, "base64");
      const image = readPngWithinBudget(bytes, context.maxBytes);
      if (image.width !== 32 || image.height !== 32)
        throw new Error("系统图标尺寸无效。");
      return {
        iconDataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      };
    },
  };
}
