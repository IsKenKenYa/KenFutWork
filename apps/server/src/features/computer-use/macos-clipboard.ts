import { randomUUID } from "node:crypto";
import type { CuOperationContext } from "./executor.js";
import { runJxa } from "./jxa.js";

interface ClipboardSnapshot {
  changeCount: number;
  items: Array<Array<{ type: string; data: string }>>;
}
const OWNER_TYPE = "org.kenfutwork.computer-use.clipboard-owner";

/** 多格式备份只在本次调用内存中；不进结果/事件。并发用户复制时不覆盖新剪贴板。 */
export async function withMacosClipboardText<T>(
  text: string,
  context: CuOperationContext,
  timeoutMs: number,
  paste: () => Promise<T>,
): Promise<T> {
  const timeout = context.timeoutMs ?? timeoutMs;
  const snapshot = (await runJxa(
    `ObjC.import('AppKit');
const pb=$.NSPasteboard.generalPasteboard, items=[];
const native=pb.pasteboardItems;
for(let i=0;i<Number(native.count);i++) {
  const item=native.objectAtIndex(i), types=item.types, row=[];
  for(let j=0;j<Number(types.count);j++) {
    const type=types.objectAtIndex(j), data=item.dataForType(type);
    if(data) row.push({type:ObjC.unwrap(type),data:ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
  }
  items.push(row);
}
JSON.stringify({changeCount:Number(pb.changeCount),items});`,
    timeout,
    context.signal,
    context.maxOutputBytes,
  )) as ClipboardSnapshot;
  const owner = randomUUID();
  let writtenCount: number | undefined;
  try {
    const written = (await runJxa(
      `ObjC.import('AppKit');
const pb=$.NSPasteboard.generalPasteboard;
if(Number(pb.changeCount)!==${snapshot.changeCount}) throw new Error('clipboard_changed: 用户已复制新的内容，请重试输入');
const item=$.NSPasteboardItem.alloc.init;
item.setStringForType(${JSON.stringify(text)},$.NSPasteboardTypeString);
item.setStringForType(${JSON.stringify(owner)},${JSON.stringify(OWNER_TYPE)});
pb.clearContents;
if(!pb.writeObjects($.NSArray.arrayWithObject(item))) throw new Error('无法设置临时剪贴板');
JSON.stringify({changeCount:Number(pb.changeCount)});`,
      timeout,
      context.signal,
      context.maxOutputBytes,
    )) as { changeCount: number };
    writtenCount = written.changeCount;
    return await paste();
  } finally {
    // 取消只终止动作；恢复使用独立、有界的清理命令。
    await runJxa(
      `ObjC.import('AppKit');
const pb=$.NSPasteboard.generalPasteboard;
const marker=ObjC.unwrap(pb.stringForType(${JSON.stringify(OWNER_TYPE)}));
if(marker===${JSON.stringify(owner)} && (${writtenCount ?? "null"}===null || Number(pb.changeCount)===${writtenCount ?? "null"})) {
  const snapshot=${JSON.stringify(snapshot)}, restored=$.NSMutableArray.alloc.init;
  for(const row of snapshot.items) {
    const item=$.NSPasteboardItem.alloc.init;
    for(const entry of row) {
      const data=$.NSData.alloc.initWithBase64EncodedStringOptions(entry.data,0);
      item.setDataForType(data,entry.type);
    }
    restored.addObject(item);
  }
  pb.clearContents;
  if(Number(restored.count) && !pb.writeObjects(restored)) throw new Error('无法恢复原剪贴板');
}
JSON.stringify({ok:true});`,
      timeout,
      undefined,
      context.maxOutputBytes,
    );
  }
}
