import {
  ArrowUpRight,
  Code2,
  KeyRound,
  Layers,
  Paintbrush,
} from "lucide-react";
import { useState } from "react";
import { links } from "./links.js";

const modes = {
  code: {
    label: "Code",
    title: "从想法到代码",
    text: "编写、调试、整理文件",
    icon: Code2,
  },
  design: {
    label: "Design",
    title: "让灵感落在画布上",
    text: "图片、视频、自由画布",
    icon: Paintbrush,
  },
};

export function ProductPanel() {
  const [mode, setMode] = useState<keyof typeof modes>("code");
  const current = modes[mode];
  const Icon = current.icon;
  return (
    <>
      <fieldset className="mode-switch" aria-label="工作模式">
        {Object.entries(modes).map(([key, item]) => (
          <button
            type="button"
            key={key}
            aria-pressed={key === mode}
            onClick={() => setMode(key as keyof typeof modes)}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      <div className="mode-detail" aria-live="polite">
        <Icon size={38} strokeWidth={1.3} />
        <h3>{current.title}</h3>
        <p>{current.text}</p>
      </div>
      <div className="product-facts">
        <span>
          <KeyRound size={17} /> 自选模型
        </span>
        <span>
          <Layers size={17} /> 本地优先
        </span>
      </div>
      <a
        className="primary-button dialog-primary"
        href={links.guide}
        target="_blank"
        rel="noreferrer"
      >
        了解 KenFutWork <ArrowUpRight size={20} />
      </a>
    </>
  );
}
