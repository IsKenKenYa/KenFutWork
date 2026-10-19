import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type MediaModelInfo,
  MediaModelPreferencePopover,
} from "../src/components/workbench/zcode/host/media/MediaModelPreferencePopover.js";
import type { MediaModelPreference } from "../src/components/workbench/zcode/host/media/mediaModelPreference.js";
import {
  readImageModelPreference,
  useImageModelPreference,
} from "../src/components/workbench/zcode/host/media/useImageModelPreference.js";
import {
  readVideoModelPreference,
  useVideoModelPreference,
} from "../src/components/workbench/zcode/host/media/useVideoModelPreference.js";

const IMAGE_KEY = "kenfutwork:image-model-preference";
const VIDEO_KEY = "kenfutwork:video-model-preference";
const emptyPreference: MediaModelPreference = { mode: "auto", models: [] };

function model(id: string, displayName: string): MediaModelInfo {
  return { id, displayName, provider: "test", description: "" };
}
const imageModels = [
  model("gpt-image", "GPT Image"),
  model("seedream", "Seedream"),
];
const videoModels = [model("h3", "MiniMax H3"), model("seedance", "Seedance")];

function PreferenceStatus() {
  const image = useImageModelPreference();
  const video = useVideoModelPreference();
  return (
    <>
      <output data-testid="image-preference">
        {JSON.stringify(image.preference)}
      </output>
      <output data-testid="video-preference">
        {JSON.stringify(video.preference)}
      </output>
      <output data-testid="image-active">
        {JSON.stringify(image.activeImageGenerationPreference ?? null)}
      </output>
      <output data-testid="video-active">
        {JSON.stringify(video.activeVideoGenerationPreference ?? null)}
      </output>
    </>
  );
}

function renderPreferences(
  options: {
    images?: MediaModelInfo[];
    videos?: MediaModelInfo[];
    controlled?: { image: MediaModelPreference; video: MediaModelPreference };
  } = {},
) {
  const loadImages = vi.fn(async () => ({
    models: options.images ?? imageModels,
  }));
  const loadVideos = vi.fn(async () => ({
    models: options.videos ?? videoModels,
  }));
  const onClose = vi.fn();
  function Panel() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [preferences, setPreferences] = useState(options.controlled);
    return (
      <>
        <button ref={anchorRef} type="button">
          媒体模型
        </button>
        <MediaModelPreferencePopover
          open
          onClose={onClose}
          anchorRef={anchorRef}
          loadImages={loadImages}
          loadVideos={loadVideos}
          {...(preferences
            ? { preferences, onPreferencesChange: setPreferences }
            : {})}
        />
        <PreferenceStatus />
        <output data-testid="draft-preferences">
          {JSON.stringify(preferences ?? null)}
        </output>
      </>
    );
  }
  return { ...render(<Panel />), loadImages, loadVideos, onClose };
}

beforeEach(() => {
  localStorage.clear();
  readImageModelPreference();
  readVideoModelPreference();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("模型目录为空时不预选虚构模型，空手动选择不会形成生成偏好", async () => {
  const view = renderPreferences({ images: [], videos: [] });
  await waitFor(() => expect(view.loadImages).toHaveBeenCalledOnce());
  expect(view.loadVideos).toHaveBeenCalledOnce();
  expect(readImageModelPreference()).toEqual(emptyPreference);
  expect(readVideoModelPreference()).toEqual(emptyPreference);
  expect(view.getAllByRole("button")).toHaveLength(4);

  fireEvent.click(view.getByRole("button", { name: "自动" }));
  expect(readImageModelPreference()).toEqual({ mode: "manual", models: [] });
  expect(view.getByTestId("image-active").textContent).toBe("null");
  fireEvent.click(view.getByRole("button", { name: "视频" }));
  expect(view.getByRole("button", { name: "自动" })).toBeTruthy();
  expect(view.getByTestId("video-active").textContent).toBe("null");
});

it("恢复已有图片和视频选择，切换标签与重新打开不覆盖持久设置", async () => {
  const image: MediaModelPreference = { mode: "manual", models: ["seedream"] };
  const video: MediaModelPreference = { mode: "manual", models: ["h3"] };
  localStorage.setItem(IMAGE_KEY, JSON.stringify(image));
  localStorage.setItem(VIDEO_KEY, JSON.stringify(video));
  const view = renderPreferences();
  await view.findByRole("button", { name: "Seedream" });
  expect(view.getByTestId("image-preference").textContent).toBe(
    JSON.stringify(image),
  );
  expect(view.getByTestId("video-preference").textContent).toBe(
    JSON.stringify(video),
  );
  fireEvent.click(view.getByRole("button", { name: "视频" }));
  await view.findByRole("button", { name: "MiniMax H3" });
  fireEvent.click(view.getByRole("button", { name: "图像" }));
  expect(localStorage.getItem(IMAGE_KEY)).toBe(JSON.stringify(image));
  expect(localStorage.getItem(VIDEO_KEY)).toBe(JSON.stringify(video));
  view.unmount();

  const reopened = renderPreferences();
  await reopened.findByRole("button", { name: "GPT Image" });
  expect(reopened.getByTestId("image-active").textContent).toBe(
    JSON.stringify(image),
  );
  expect(reopened.getByTestId("video-active").textContent).toBe(
    JSON.stringify(video),
  );
});

it("自动模式点图片模型只选本次模型，多选可切换但保留最后一个选择", async () => {
  localStorage.setItem(
    IMAGE_KEY,
    JSON.stringify({ mode: "auto", models: ["old-image"] }),
  );
  const video: MediaModelPreference = { mode: "manual", models: ["h3"] };
  localStorage.setItem(VIDEO_KEY, JSON.stringify(video));
  const view = renderPreferences();
  fireEvent.click(await view.findByRole("button", { name: "GPT Image" }));
  expect(readImageModelPreference()).toEqual({
    mode: "manual",
    models: ["gpt-image"],
  });
  fireEvent.click(view.getByRole("button", { name: "Seedream" }));
  expect(readImageModelPreference().models).toEqual(["gpt-image", "seedream"]);
  fireEvent.click(view.getByRole("button", { name: "GPT Image" }));
  fireEvent.click(view.getByRole("button", { name: "Seedream" }));
  const image: MediaModelPreference = { mode: "manual", models: ["seedream"] };
  expect(readImageModelPreference()).toEqual(image);
  expect(view.getByTestId("image-preference").textContent).toBe(
    JSON.stringify(image),
  );
  expect(localStorage.getItem(IMAGE_KEY)).toBe(JSON.stringify(image));
  expect(readVideoModelPreference()).toEqual(video);
  expect(localStorage.getItem(VIDEO_KEY)).toBe(JSON.stringify(video));
});

it("视频选择和自动模式独立于图片设置，恢复手动模式保留原视频选择", async () => {
  const image: MediaModelPreference = { mode: "manual", models: ["gpt-image"] };
  localStorage.setItem(IMAGE_KEY, JSON.stringify(image));
  localStorage.setItem(
    VIDEO_KEY,
    JSON.stringify({ mode: "auto", models: ["old-video"] }),
  );
  const view = renderPreferences();
  fireEvent.click(view.getByRole("button", { name: "视频" }));
  fireEvent.click(await view.findByRole("button", { name: "MiniMax H3" }));
  expect(readVideoModelPreference()).toEqual({
    mode: "manual",
    models: ["h3"],
  });
  fireEvent.click(view.getByRole("button", { name: "Seedance" }));
  fireEvent.click(view.getByRole("button", { name: "手动" }));
  expect(readVideoModelPreference()).toEqual({
    mode: "auto",
    models: ["h3", "seedance"],
  });
  expect(view.getByTestId("video-active").textContent).toBe("null");
  fireEvent.click(view.getByRole("button", { name: "自动" }));
  const video: MediaModelPreference = {
    mode: "manual",
    models: ["h3", "seedance"],
  };
  expect(view.getByTestId("video-active").textContent).toBe(
    JSON.stringify(video),
  );
  expect(localStorage.getItem(VIDEO_KEY)).toBe(JSON.stringify(video));
  expect(readImageModelPreference()).toEqual(image);
  expect(localStorage.getItem(IMAGE_KEY)).toBe(JSON.stringify(image));
});

it("旧单模型设置按原图片或视频键恢复，不混用两类历史选择", () => {
  localStorage.setItem(
    IMAGE_KEY,
    JSON.stringify({ mode: "manual", model: "old-image" }),
  );
  localStorage.setItem(
    VIDEO_KEY,
    JSON.stringify({ mode: "manual", model: "old-video" }),
  );

  expect(readImageModelPreference()).toEqual({
    mode: "manual",
    models: ["old-image"],
  });
  expect(readVideoModelPreference()).toEqual({
    mode: "manual",
    models: ["old-video"],
  });
});

it("草稿覆盖设置仅修改本次选择，不覆盖全局图片或视频偏好", async () => {
  const globalImage: MediaModelPreference = {
    mode: "manual",
    models: ["seedream"],
  };
  const globalVideo: MediaModelPreference = {
    mode: "manual",
    models: ["seedance"],
  };
  localStorage.setItem(IMAGE_KEY, JSON.stringify(globalImage));
  localStorage.setItem(VIDEO_KEY, JSON.stringify(globalVideo));
  const view = renderPreferences({
    controlled: { image: emptyPreference, video: emptyPreference },
  });
  fireEvent.click(await view.findByRole("button", { name: "GPT Image" }));
  fireEvent.click(view.getByRole("button", { name: "视频" }));
  fireEvent.click(await view.findByRole("button", { name: "MiniMax H3" }));

  expect(view.getByTestId("draft-preferences").textContent).toBe(
    JSON.stringify({
      image: { mode: "manual", models: ["gpt-image"] },
      video: { mode: "manual", models: ["h3"] },
    }),
  );
  expect(localStorage.getItem(IMAGE_KEY)).toBe(JSON.stringify(globalImage));
  expect(localStorage.getItem(VIDEO_KEY)).toBe(JSON.stringify(globalVideo));
});

it.each([
  { label: "图片", key: IMAGE_KEY, read: readImageModelPreference },
  { label: "视频", key: VIDEO_KEY, read: readVideoModelPreference },
])("$label设置损坏后连续读取不重新使用旧选择", ({ key, read }) => {
  const stored: MediaModelPreference = {
    mode: "manual",
    models: ["previous-model"],
  };
  localStorage.setItem(key, JSON.stringify(stored));
  expect(read()).toEqual(stored);
  localStorage.setItem(key, "{");

  expect(read()).toEqual(emptyPreference);
  expect(read()).toEqual(emptyPreference);
});
