import { useId } from "react";

type ModelParameterFieldProps = {
  label: string;
  value: string;
  options?: readonly string[] | undefined;
  onChange: (value: string) => void;
  numeric?: boolean;
  placeholder?: string;
};

/** 模型声明枚举时选择，未知时允许输入；空数组表示不支持。 */
export function ModelParameterField({
  label,
  value,
  options,
  onChange,
  numeric = false,
  placeholder,
}: ModelParameterFieldProps) {
  const controlId = useId();
  if (options?.length === 0) return null;
  const controlClass =
    "h-8 w-[126px] rounded-lg border border-border bg-card px-2 text-xs text-foreground";
  return (
    <label
      htmlFor={controlId}
      className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
    >
      {label}
      {options ? (
        <select
          id={controlId}
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={controlClass}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option || "自动"}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={controlId}
          aria-label={label}
          type={numeric ? "number" : "text"}
          min={numeric ? 1 : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={controlClass}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}
