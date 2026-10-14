import { useEffect, useRef } from "react";
import { attachPointerReveal } from "./pointer-reveal.mjs";

export function HeroBackground() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return attachPointerReveal(element, window);
  }, []);
  return (
    <div className="hero-art" aria-hidden="true" ref={ref}>
      <div className="hero-layer" />
      <div className="hero-reveal">
        <div className="hero-layer hero-layer-tinted" />
      </div>
    </div>
  );
}
