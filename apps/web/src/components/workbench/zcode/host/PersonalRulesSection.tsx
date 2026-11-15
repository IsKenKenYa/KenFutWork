import { Button } from "@zui/components/ui/button.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { SettingsFormActions } from "@zui/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@zui/settings/SettingsFormTextarea.js";
import { useEffect, useId, useRef } from "react";
import {
  personalRulesLimit,
  type usePersonalRules,
} from "./usePersonalRules.js";

export function PersonalRulesSection({
  editor,
}: {
  editor: ReturnType<typeof usePersonalRules>;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const ready = editor.readState === "ready";
  const editable = ready && !editor.saving;
  const title = intl.formatMessage({ id: "settings.personalRules.title" });
  const invalid = editor.notice === "invalid";
  const failedToRead = editor.readState === "failed";
  const failed = failedToRead || invalid || editor.notice === "saveFailed";
  let feedback = editor.notice ?? (editor.dirty ? "dirty" : null);
  if (editor.saving) feedback = "saving";
  if (!ready) feedback = failedToRead ? "readFailed" : "loading";
  const feedbackText = feedback
    ? intl.formatMessage(
        { id: `settings.personalRules.${feedback}` },
        { limit: personalRulesLimit },
      )
    : null;
  useEffect(() => {
    if (invalid) field.current?.focus();
  }, [invalid]);
  return (
    <form
      method="post"
      aria-labelledby={`${id}-label`}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void editor.save();
      }}
      onKeyDown={(event) => {
        if (
          !(event.metaKey || event.ctrlKey) ||
          event.key.toLowerCase() !== "s" ||
          event.nativeEvent.isComposing
        )
          return;
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }}
    >
      <div className="space-y-1.5">
        <label id={`${id}-label`} htmlFor={id} className="font-medium">
          {title}
        </label>
        <p id={`${id}-hint`} className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.personalRules.scope" })}
        </p>
        <SettingsFormTextarea
          ref={field}
          id={id}
          name="userRules"
          rows={8}
          className="w-full resize-y"
          aria-describedby={`${id}-hint ${id}-count ${id}-error`}
          aria-invalid={invalid || undefined}
          disabled={!ready}
          readOnly={editor.saving}
          value={editor.draft}
          onChange={(event) => editor.edit(event.target.value)}
        />
      </div>
      <SettingsFormActions
        leadingAction={
          <div className="space-x-2 text-ui-sm text-foreground-subtle">
            <span id={`${id}-count`}>
              {ready
                ? intl.formatMessage(
                    { id: "settings.personalRules.count" },
                    { count: editor.draft.length, limit: personalRulesLimit },
                  )
                : null}
            </span>
            <span id={`${id}-error`} role="alert">
              {failed ? feedbackText : null}
            </span>
            <span role="status">{failed ? null : feedbackText}</span>
            {failedToRead ? (
              <Button type="button" variant="ghost" onClick={editor.retryRead}>
                {intl.formatMessage({ id: "settings.personalRules.retry" })}
              </Button>
            ) : null}
          </div>
        }
      >
        <Button
          type="button"
          variant="ghost"
          disabled={!editable || !editor.dirty}
          onClick={editor.discard}
        >
          {intl.formatMessage({ id: "settings.personalRules.discard" })}
        </Button>
        <Button type="submit" disabled={!editable || !editor.dirty}>
          {intl.formatMessage({ id: "settings.personalRules.save" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
