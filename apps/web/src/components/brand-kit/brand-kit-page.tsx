"use client";

import type {
  BrandKitAssetType,
  BrandKitDetail,
  BrandKitSummary,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBrandKit,
  createBrandKitAsset,
  deleteBrandKit,
  deleteBrandKitAsset,
  duplicateBrandKit,
  fetchBrandKit,
  fetchBrandKits,
  updateBrandKit,
  updateBrandKitAsset,
  uploadBrandKitAsset,
} from "../../lib/brand-kit-api";
import { ApiAccessError } from "../../lib/server-api";
import { BrandKitSkeleton } from "../skeletons/brand-kit-skeleton";
import { BrandKitEditor } from "./brand-kit-editor";
import { BrandKitSidebar } from "./brand-kit-sidebar";
import { EmptyState } from "./empty-state";

export function BrandKitPage() {
  const [kits, setKits] = useState<BrandKitSummary[]>([]);
  const [selectedKit, setSelectedKit] = useState<BrandKitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedKitRef = useRef<BrandKitDetail | null>(null);
  const selectionRef = useRef<{
    id: string | null;
    generation: number;
    request: number;
  }>({ id: null, generation: 0, request: 0 });

  const beginSelection = useCallback((id: string | null) => {
    const generation = selectionRef.current.generation + 1;
    selectionRef.current = { id, generation, request: 0 };
    return generation;
  }, []);

  const commitKit = useCallback(
    (kit: BrandKitDetail | null, generation: number, request?: number) => {
      const selection = selectionRef.current;
      if (
        selection.generation !== generation ||
        (request !== undefined && selection.request !== request)
      )
        return;
      selection.id = kit?.id ?? null;
      selectedKitRef.current = kit;
      setSelectedKit(kit);
    },
    [],
  );

  const handleAuthError = useCallback(async (err: unknown) => {
    if (err instanceof ApiAccessError) {
      return true;
    }
    return false;
  }, []);

  const hasInitialized = useRef(false);

  // --- Data loading (ref-based, no dependency cascades) ---

  const loadKitDetail = useCallback(
    async (kitId: string, generation: number) => {
      if (
        selectionRef.current.id !== kitId ||
        selectionRef.current.generation !== generation
      )
        return;
      const request = ++selectionRef.current.request;
      try {
        const detail = await fetchBrandKit(null, kitId);
        commitKit(detail, generation, request);
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to load brand kit detail:", err);
      }
    },
    [commitKit, handleAuthError],
  );

  const refreshList = useCallback(async () => {
    try {
      const data = await fetchBrandKits(null);
      setKits(data.brandKits);
      return data.brandKits;
    } catch (err) {
      if (await handleAuthError(err)) return [];
      console.error("Failed to load brand kits:", err);
      return [];
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    (async () => {
      setLoading(true);
      try {
        const data = await fetchBrandKits(null);
        setKits(data.brandKits);
        const firstKit = data.brandKits[0];
        if (firstKit) {
          await loadKitDetail(firstKit.id, beginSelection(firstKit.id));
        }
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to load brand kits:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [beginSelection, handleAuthError, loadKitDetail]);

  // --- Kit handlers ---

  const handleSelectKit = useCallback(
    async (kitId: string) => {
      await loadKitDetail(kitId, beginSelection(kitId));
    },
    [beginSelection, loadKitDetail],
  );

  const handleCreateKit = useCallback(async () => {
    const previous = selectedKitRef.current;
    const generation = beginSelection(null);
    try {
      const newKit = await createBrandKit(null);
      await refreshList();
      commitKit(newKit, generation);
    } catch (err) {
      commitKit(previous, generation);
      if (await handleAuthError(err)) return;
      console.error("Failed to create brand kit:", err);
    }
  }, [beginSelection, commitKit, handleAuthError, refreshList]);

  const handleDuplicateKit = useCallback(async () => {
    const kit = selectedKitRef.current;
    if (!kit || selectionRef.current.id !== kit.id) return;
    const generation = beginSelection(null);
    try {
      const duplicated = await duplicateBrandKit(null, kit.id);
      await refreshList();
      commitKit(duplicated, generation);
    } catch (err) {
      commitKit(kit, generation);
      if (await handleAuthError(err)) return;
      console.error("Failed to duplicate brand kit:", err);
    }
  }, [beginSelection, commitKit, handleAuthError, refreshList]);

  const handleUpdateKit = useCallback(
    async (data: {
      name?: string;
      guidance_text?: string | null;
      is_default?: boolean;
    }) => {
      const kit = selectedKitRef.current;
      if (!kit || selectionRef.current.id !== kit.id) return;
      const { generation } = selectionRef.current;
      const request = ++selectionRef.current.request;
      try {
        const updated = await updateBrandKit(null, kit.id, data);
        commitKit(updated, generation, request);
        await refreshList();
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to update brand kit:", err);
      }
    },
    [commitKit, handleAuthError, refreshList],
  );

  const handleDeleteKit = useCallback(async () => {
    const kit = selectedKitRef.current;
    if (!kit || selectionRef.current.id !== kit.id) return;
    const { generation } = selectionRef.current;
    try {
      await deleteBrandKit(null, kit.id);
      const remaining = await refreshList();
      if (
        selectionRef.current.id !== kit.id ||
        selectionRef.current.generation !== generation
      )
        return;
      const nextKit = remaining[0];
      if (nextKit) {
        await loadKitDetail(nextKit.id, beginSelection(nextKit.id));
      } else {
        commitKit(null, beginSelection(null));
      }
    } catch (err) {
      if (await handleAuthError(err)) return;
      console.error("Failed to delete brand kit:", err);
    }
  }, [beginSelection, commitKit, handleAuthError, refreshList, loadKitDetail]);

  const handleDeleteKitFromSidebar = useCallback(
    async (kitId: string) => {
      const { generation } = selectionRef.current;
      try {
        await deleteBrandKit(null, kitId);
        const remaining = await refreshList();
        if (
          selectionRef.current.id === kitId &&
          selectionRef.current.generation === generation
        ) {
          const nextKit = remaining[0];
          if (nextKit) {
            await loadKitDetail(nextKit.id, beginSelection(nextKit.id));
          } else {
            commitKit(null, beginSelection(null));
          }
        }
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to delete brand kit:", err);
      }
    },
    [beginSelection, commitKit, handleAuthError, refreshList, loadKitDetail],
  );

  // --- Asset handlers ---

  const handleAddAsset = useCallback(
    async (
      type: BrandKitAssetType,
      displayName: string,
      textContent?: string | null,
      metadata?: Record<string, unknown>,
    ) => {
      const kit = selectedKitRef.current;
      if (!kit || selectionRef.current.id !== kit.id) return;
      const { generation } = selectionRef.current;
      try {
        await createBrandKitAsset(null, kit.id, {
          asset_type: type,
          display_name: displayName,
          text_content: textContent ?? null,
          metadata,
        });
        await loadKitDetail(kit.id, generation);
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to create asset:", err);
      }
    },
    [handleAuthError, loadKitDetail],
  );

  const handleUpdateAsset = useCallback(
    async (
      assetId: string,
      data: { display_name?: string; text_content?: string | null },
    ) => {
      const kit = selectedKitRef.current;
      if (!kit || selectionRef.current.id !== kit.id) return;
      const { generation } = selectionRef.current;
      try {
        await updateBrandKitAsset(null, kit.id, assetId, data);
        await loadKitDetail(kit.id, generation);
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to update asset:", err);
      }
    },
    [handleAuthError, loadKitDetail],
  );

  const handleDeleteAsset = useCallback(
    async (assetId: string) => {
      const kit = selectedKitRef.current;
      if (!kit || selectionRef.current.id !== kit.id) return;
      const { generation } = selectionRef.current;
      try {
        await deleteBrandKitAsset(null, kit.id, assetId);
        await loadKitDetail(kit.id, generation);
        await refreshList();
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to delete asset:", err);
      }
    },
    [handleAuthError, loadKitDetail, refreshList],
  );

  const handleUploadAsset = useCallback(
    async (type: "logo" | "image", file: File) => {
      const kit = selectedKitRef.current;
      if (!kit || selectionRef.current.id !== kit.id) return;
      const { generation } = selectionRef.current;
      try {
        await uploadBrandKitAsset(null, kit.id, type, file);
        await loadKitDetail(kit.id, generation);
        await refreshList();
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to upload asset:", err);
      }
    },
    [handleAuthError, loadKitDetail, refreshList],
  );

  // --- Render ---

  if (loading) {
    return <BrandKitSkeleton />;
  }

  return (
    <div className="flex h-[100dvh] w-full flex-col bg-background md:flex-row">
      {/* Sidebar: full width horizontal on mobile, vertical panel on md+ */}
      <BrandKitSidebar
        kits={kits}
        selectedKitId={selectedKit?.id ?? null}
        onSelectKit={handleSelectKit}
        onCreateKit={handleCreateKit}
        onDeleteKit={handleDeleteKitFromSidebar}
      />

      {selectedKit ? (
        <BrandKitEditor
          kit={selectedKit}
          onUpdateKit={handleUpdateKit}
          onDeleteKit={handleDeleteKit}
          onDuplicateKit={handleDuplicateKit}
          onAddAsset={handleAddAsset}
          onUpdateAsset={handleUpdateAsset}
          onDeleteAsset={handleDeleteAsset}
          onUploadAsset={handleUploadAsset}
        />
      ) : (
        <EmptyState onCreateKit={handleCreateKit} />
      )}
    </div>
  );
}
