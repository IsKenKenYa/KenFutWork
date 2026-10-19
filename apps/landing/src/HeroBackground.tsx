import {
  Braces,
  CodeXml,
  GitBranch,
  Layers,
  PenTool,
  Terminal,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { attachPointerReveal } from "./pointer-reveal.mjs";
import "./hero-background.css";

function LogoLayer({ tinted = false }: { tinted?: boolean }) {
  return (
    <div className="hero-logo" data-logo-zone={!tinted || undefined}>
      <div className="hero-logo-motion">
        <div className={`hero-logo-art${tinted ? " hero-logo-tinted" : ""}`} />
      </div>
    </div>
  );
}

export function HeroBackground() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return attachPointerReveal(element, window);
  }, []);
  return (
    <div className="hero-art" aria-hidden="true" ref={ref}>
      <div className="hero-dot-field" />
      <div className="background-type-stage">
        <div className="background-type-cylinder">
          {["CODE", "DESIGN", "BUILD", "CREATE", "WORK"].map((word, index) => (
            <span
              key={word}
              style={{
                transform: `rotateX(${(index - 2) * 22}deg) translateZ(var(--type-radius))`,
              }}
            >
              {word}
            </span>
          ))}
        </div>
      </div>
      <LogoLayer />
      <div className="hero-reveal">
        <LogoLayer tinted />
        <div className="spotlight-decoration decoration-code">
          <CodeXml />
        </div>
        <div className="spotlight-decoration decoration-terminal">
          <Terminal />
        </div>
        <div className="spotlight-decoration decoration-branches">
          <GitBranch />
        </div>
        <div className="spotlight-decoration decoration-braces">
          <Braces />
        </div>
        <div className="spotlight-decoration decoration-pen">
          <PenTool />
        </div>
        <div className="spotlight-decoration decoration-layers">
          <Layers />
        </div>
      </div>
    </div>
  );
}
