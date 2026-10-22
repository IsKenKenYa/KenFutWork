export const PREVIEW_IMAGE_ADD_TO_CHAT_EVENT =
  "zcode:add-preview-image-to-chat";

export type PreviewImageSourceLoader = (
  signal?: AbortSignal,
) => Promise<string>;

export async function loadPreviewImageFile(
  loadSource: PreviewImageSourceLoader,
  filename: string,
  signal: AbortSignal,
  sourceMediaType?: "image/svg+xml",
): Promise<File> {
  signal.throwIfAborted();
  const source = await loadSource(signal);
  signal.throwIfAborted();
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error("图片原件读取失败。");
  const image = await response.blob();
  signal.throwIfAborted();
  const mediaType = sourceMediaType ?? image.type;
  if (!mediaType.startsWith("image/")) throw new Error("图片原件格式不可用。");
  return new File([image], filename, { type: mediaType });
}

interface PreviewImageChatSource {
  workspaceKey: string;
  targetSessionId: string | null;
  signal: AbortSignal;
  loadFile(signal: AbortSignal): Promise<File>;
}

interface PreviewImageChatRequest extends PreviewImageChatSource {
  claim(
    ownerSignal: AbortSignal,
    consume: (signal: AbortSignal) => Promise<boolean>,
  ): boolean;
}

function consumeUntilAborted(
  signal: AbortSignal,
  consume: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const aborted = () => resolve(false);
    if (signal.aborted) {
      resolve(false);
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return consume(signal);
      })
      .then(
        (added) => {
          signal.removeEventListener("abort", aborted);
          resolve(added);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          if (signal.aborted) resolve(false);
          else reject(error);
        },
      );
  });
}

export function isPreviewImageAddToChatEvent(
  event: Event,
): event is CustomEvent<PreviewImageChatRequest> {
  return (
    event.type === PREVIEW_IMAGE_ADD_TO_CHAT_EVENT &&
    event instanceof CustomEvent
  );
}

/** 输入框同步认领后再读取原图；来源与目标中任一方取消都结束本次请求。 */
export async function requestPreviewImageAddToChat(
  source: PreviewImageChatSource,
): Promise<boolean> {
  if (typeof window === "undefined" || source.signal.aborted) return false;
  let result: Promise<boolean> | undefined;
  const event = new CustomEvent<PreviewImageChatRequest>(
    PREVIEW_IMAGE_ADD_TO_CHAT_EVENT,
    {
      cancelable: true,
      detail: {
        ...source,
        claim(ownerSignal, consume) {
          if (result || source.signal.aborted || ownerSignal.aborted)
            return false;
          const signal = AbortSignal.any([source.signal, ownerSignal]);
          result = consumeUntilAborted(signal, consume);
          event.preventDefault();
          return true;
        },
      },
    },
  );
  window.dispatchEvent(event);
  return result ?? false;
}
