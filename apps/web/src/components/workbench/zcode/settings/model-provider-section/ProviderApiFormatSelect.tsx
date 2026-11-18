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
  "openai-compatible": "OpenAI 兼容", anthropic: "Anthropic", gemini: "Gemini", apimart: "APIMart",
  "google-image": "Google Image",
  replicate: "Replicate",
  volces: "Volcengine",
  metaso: "Metaso",
  grsai: "GRSAI",
  "dify-engine": "Dify",
};

const NATIVE_PROTOCOLS = providerProtocolSchema.options.filter(
  (protocol) => !["openai-compatible", "anthropic", "gemini"].includes(protocol),
);

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
  if (providerProtocolSchema.safeParse(format).success) return NATIVE_PROTOCOL_LABELS[format as ProviderProtocol] ?? format;
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
  const options = nativeProtocol ? NATIVE_PROTOCOLS
    : [...apiFormatOptions, ...(onNativeProtocolChange ? NATIVE_PROTOCOLS : [])];

  return (
    <Select value={nativeProtocol ?? value} onValueChange={(nextValue) => {
      const native = providerProtocolSchema.safeParse(nextValue);
      if (native.success) onNativeProtocolChange?.(native.data);
      else onChange(nextValue as ProviderApiType);
    }}>
      <SelectTrigger
        id={triggerId}
        data-testid={TID_MODEL_PROVIDER_API_FORMAT_TRIGGER}
        size="lg"
        className="w-full justify-between"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {options.map((format) => (
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
