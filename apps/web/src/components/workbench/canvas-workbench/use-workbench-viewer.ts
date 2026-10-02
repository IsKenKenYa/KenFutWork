"use client";

import { useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";
import { fetchViewer } from "@/lib/server-api";
import type { WorkbenchUser } from "../user-menu";

export function useWorkbenchViewer(accessToken: string | null) {
  const [workbenchUser, setWorkbenchUser] = useState<WorkbenchUser | null>(
    null,
  );
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchViewer(accessToken)
      .then((viewer) => {
        if (!cancelled)
          setWorkbenchUser({
            displayName: viewer.profile.displayName,
            email: viewer.profile.email,
            avatarUrl: viewer.profile.avatarUrl ?? null,
          });
      })
      .catch(() => {});
    fetch(`${getServerBaseUrl()}/api/admin/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((response) => (response.ok ? response.json() : { isAdmin: false }))
      .then((data: { isAdmin?: boolean }) => {
        if (!cancelled) setIsPlatformAdmin(Boolean(data.isAdmin));
      })
      .catch(() => {
        if (!cancelled) setIsPlatformAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);
  return { workbenchUser, isPlatformAdmin };
}
