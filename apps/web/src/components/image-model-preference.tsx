"use client";
import { MediaModelPreferencePopover } from "@zcode/ui/design-shared";
import type { ComponentProps } from "react";
import { fetchImageModels, fetchVideoModels } from "../lib/server-api";

type Props = Omit<
  ComponentProps<typeof MediaModelPreferencePopover>,
  "loadImages" | "loadVideos"
> & {
  loadImages?: typeof fetchImageModels;
  loadVideos?: typeof fetchVideoModels;
};
export function ImageModelPreferencePopover({
  loadImages = fetchImageModels,
  loadVideos = fetchVideoModels,
  ...props
}: Props) {
  return (
    <MediaModelPreferencePopover
      {...props}
      loadImages={loadImages}
      loadVideos={loadVideos}
    />
  );
}
