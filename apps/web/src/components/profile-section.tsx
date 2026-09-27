"use client";

import { useState } from "react";
import { SETTINGS_TITLE } from "@/lib/settings-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ProfileSectionProps {
  displayName: string;
  email: string;
  onSave: (displayName: string) => Promise<void>;
}

export function ProfileSection({
  displayName: initialName,
  email,
  onSave,
}: ProfileSectionProps) {
  const [displayName, setDisplayName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const hasChanges = displayName.trim() !== initialName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) return;

    setSaving(true);
    setFeedback(null);

    try {
      await onSave(trimmed);
      setFeedback({ type: "success", message: "个人资料已更新" });
    } catch {
      setFeedback({
        type: "error",
        message: "更新失败，请重试。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className={SETTINGS_TITLE}>个人资料</h2>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
        <div className="space-y-2">
          <Label htmlFor="displayName">显示名称</Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="你的名字"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input id="email" value={email} disabled className="opacity-60" />
          <p className="text-xs text-muted-foreground">邮箱不可修改</p>
        </div>

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "保存中…" : "保存"}
        </Button>
      </form>
    </div>
  );
}
