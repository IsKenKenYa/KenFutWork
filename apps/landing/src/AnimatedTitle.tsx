import type { CSSProperties } from "react";
import "./animated-title.css";

const lines = ["From idea to", "real work."];

export function AnimatedTitle() {
  let letterIndex = 0;

  return (
    <p className="hero-title animated-title">
      <span className="animated-title-accessible">From idea to real work.</span>
      {lines.map((line) => (
        <span className="letter-swap-line" aria-hidden="true" key={line}>
          {Array.from(line).map((letter, index) => {
            const style = {
              "--letter-delay": `${letterIndex++ * 0.03}s`,
            } as CSSProperties;

            return (
              <span
                className="letter-swap-character"
                // biome-ignore lint/suspicious/noArrayIndexKey: 固定文案的字位决定错峰动画，无重排或状态
                key={`${line}-${index}`}
                style={style}
              >
                <span className="letter-swap-front">
                  {letter === " " ? "\u00a0" : letter}
                </span>
                <span className="letter-swap-back">
                  {letter === " " ? "\u00a0" : letter}
                </span>
              </span>
            );
          })}
        </span>
      ))}
    </p>
  );
}
