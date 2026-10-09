import type { ProviderApiType } from "@zcode/provider";
import { providerProtocolSchema, type ProviderProtocol } from "@kenfutwork/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import {
  TID_MODEL_PROVIDER_API_FORMAT_ITEM,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  testId,
} from "@zcode/shared";

const PROVIDER_CONNECTION_API_FORMATS: readonly ProviderApiType[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
  "google-generative-language",
];
const NATIVE_PROTOCOL_LABELS: Partial<Record<ProviderProtocol, string>> = {
  "google-image": "Google Image",
  replicate: "Replicate",
  volces: "Volcengine",
  metaso: "Metaso",
  "dify-engine": "Dify",
};

const PROVIDER_CONNECTION_API_FORMAT_PATHS: Record<ProviderApiType, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-chat-completions": "/chat/completions",
  "openai-responses": "/responses",
  "google-generative-language": "/models/{model}:streamGenerateContent",
};

const PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS: Record<ProviderApiType, string> = {
  "anthropic-messages": "settings.modelProvider.apiFormat.title.anthropicMessages",
  "openai-chat-completions": "settings.modelProvider.apiFormat.title.chatCompletions",
  "openai-responses": "settings.modelProvider.apiFormat.title.responses",
  "google-generative-language": "settings.modelProvider.apiFormat.title.gemini",
};

export function resolveProviderConnectionApiFormatOptions(): ProviderApiType[] {
  return [...PROVIDER_CONNECTION_API_FORMATS];
}

export function resolveProviderConnectionApiFormatDisplayLabel(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  format: ProviderApiType | ProviderProtocol,
): string {
  if (format in NATIVE_PROTOCOL_LABELS) return NATIVE_PROTOCOL_LABELS[format as ProviderProtocol]!;
  const title = intl.formatMessage({
    id: PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS[format as ProviderApiType],
  });
  return `${title} (${PROVIDER_CONNECTION_API_FORMAT_PATHS[format as ProviderApiType]})`;
}

export function ProviderApiFormatSelect({
  apiFormatOptions = PROVIDER_CONNECTION_API_FORMATS,
  triggerId,
  value,
  onChange,
  nativeProtocol,
  onNativeProtocolChange,
}: {
  apiFormatOptions?: readonly ProviderApiType[];
  triggerId?: string;
  value: ProviderApiType;
  onChange: (value: ProviderApiType) => void;
  nativeProtocol?: ProviderProtocol | undefined;
  onNativeProtocolChange?: ((value: ProviderProtocol) => void) | undefined;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Select value={nativeProtocol ?? value} onValueChange={(nextValue) => nativeProtocol ? onNativeProtocolChange?.(providerProtocolSchema.parse(nextValue)) : onChange(nextValue as ProviderApiType)}>
      <SelectTrigger
        id={triggerId}
        data-testid={TID_MODEL_PROVIDER_API_FORMAT_TRIGGER}
        size="lg"
        className="w-full justify-between"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {(nativeProtocol ? Object.keys(NATIVE_PROTOCOL_LABELS) as ProviderProtocol[] : apiFormatOptions).map((format) => (
          <SelectItem
            key={format}
            value={format}
            data-testid={testId(TID_MODEL_PROVIDER_API_FORMAT_ITEM, format)}
          >
            {resolveProviderConnectionApiFormatDisplayLabel(intl, format)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
