"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SectionHeader } from "./section-header";

interface GuidanceSectionProps {
  value: string | null;
  onSave: (text: string | null) => void;
}

const DEBOUNCE_MS = 1000;

export function GuidanceSection({ value, onSave }: GuidanceSectionProps) {
  const [draft, setDraft] = useState(value ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Sync from parent when value changes externally
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  // Auto-resize textarea
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft 只当触发器（高度按 DOM 现量，不读值）；去掉后输入不再自动长高
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const flush = useCallback(
    (text: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const trimmed = text.trim();
      const newValue = trimmed || null;
      if (newValue !== value) {
        onSaveRef.current(newValue);
      }
    },
    [value],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newDraft = e.target.value;
      setDraft(newDraft);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flush(newDraft), DEBOUNCE_MS);
    },
    [flush],
  );

  const handleBlur = useCallback(() => {
    flush(draft);
  }, [flush, draft]);

  return (
    <section>
      <SectionHeader title="品牌规范" />
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="品牌语气与风格"
        rows={3}
        className="w-full resize-none rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/60 transition-colors"
      />
    </section>
  );
}
