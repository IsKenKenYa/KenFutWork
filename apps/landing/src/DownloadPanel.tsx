import { ArrowDownToLine, ArrowUpRight, Laptop, Monitor } from "lucide-react";
import { useState } from "react";
import { links } from "./links.js";

const platforms = [
  { name: "macOS", detail: "Apple Silicon", icon: Laptop },
  { name: "macOS", detail: "Intel", icon: Laptop },
  { name: "Windows", detail: "x64", icon: Monitor },
];

export function DownloadPanel() {
  const [selected, setSelected] = useState(0);
  return (
    <>
      <p className="dialog-intro">让想法在你的电脑上成真</p>
      <fieldset className="platforms" aria-label="选择平台">
        {platforms.map(({ name, detail, icon: Icon }, index) => (
          <button
            key={detail}
            type="button"
            className="platform"
            aria-pressed={selected === index}
            onClick={() => setSelected(index)}
          >
            <Icon size={28} strokeWidth={1.4} />
            <strong>{name}</strong>
            <span>{detail}</span>
            <span className="platform-check" aria-hidden="true" />
          </button>
        ))}
      </fieldset>
      <div className="release-state" aria-live="polite">
        <span>
          {platforms[selected].name} · {platforms[selected].detail}
        </span>
        <span>安装包未发布</span>
      </div>
      <a
        className="primary-button dialog-primary"
        href={links.releases}
        target="_blank"
        rel="noreferrer"
      >
        查看发布 <ArrowDownToLine size={20} strokeWidth={1.6} />
      </a>
      <a
        className="text-link source-link"
        href={links.guide}
        target="_blank"
        rel="noreferrer"
      >
        从源码开始 <ArrowUpRight size={16} />
      </a>
    </>
  );
}
