import {
  instanceSettingsResponseSchema,
  instanceSettingsSchema,
} from "@kenfutwork/shared";
import { useEffect, useRef, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

const settingsPath = "/api/instance/settings";
const rulesSchema = instanceSettingsSchema.shape.userRules.unwrap();
const maxLength = rulesSchema.maxLength;
if (maxLength === null) throw new Error("个人指令缺少长度上限。");
export const personalRulesLimit = maxLength;

async function requestRules(init?: RequestInit) {
  const response = await surfaceJson<unknown>(settingsPath, init);
  return instanceSettingsResponseSchema.parse(response).settings.userRules;
}

/** 由设置页持有，分区切换不会丢失草稿或保存结果。 */
export function usePersonalRules(active: boolean) {
  const [loadAttempt, setLoadAttempt] = useState(active ? 1 : 0);
  const [readState, setReadState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<
    "invalid" | "saved" | "saveFailed" | null
  >(null);
  const writing = useRef(false);

  useEffect(() => {
    if (active) setLoadAttempt((current) => current || 1);
  }, [active]);

  useEffect(() => {
    if (!loadAttempt) return;
    const controller = new AbortController();
    requestRules({ signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setSaved(value);
        setDraft(value);
        setReadState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setReadState("failed");
      });
    return () => controller.abort();
  }, [loadAttempt]);

  const dirty = draft !== saved;
  async function save() {
    if (readState !== "ready" || !dirty || writing.current) return;
    if (!rulesSchema.safeParse(draft).success) {
      setNotice("invalid");
      return;
    }
    writing.current = true;
    setSaving(true);
    setNotice(null);
    try {
      const value = await requestRules({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userRules: draft }),
      });
      setSaved(value);
      setDraft(value);
      setNotice("saved");
    } catch {
      setNotice("saveFailed");
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  return {
    draft,
    dirty,
    notice,
    readState,
    saving,
    save,
    edit(value: string) {
      setDraft(value);
      setNotice(null);
    },
    discard() {
      setDraft(saved);
      setNotice(null);
    },
    retryRead() {
      setReadState("loading");
      setLoadAttempt((current) => current + 1);
    },
  };
}
