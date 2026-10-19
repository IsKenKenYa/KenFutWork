import { ArrowDownToLine, ArrowUpRight, Menu, X } from "lucide-react";
import { useState } from "react";
import { AnimatedTitle } from "./AnimatedTitle.js";
import { Dialog } from "./Dialog.js";
import { DownloadPanel } from "./DownloadPanel.js";
import { HeroBackground } from "./HeroBackground.js";
import { links, repositoryUrl } from "./links.js";
import { ProductPanel } from "./ProductPanel.js";

const navigation = [
  { label: "使用指南", href: links.guide },
  { label: "更新日志", href: links.changelog },
  { label: "GitHub", href: repositoryUrl },
];

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<"download" | "product" | null>(null);
  function openDownload() {
    setMenuOpen(false);
    setPanel("download");
  }
  return (
    <div className="landing">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <HeroBackground />
      <header className="header">
        <a className="brand" href="./" aria-label="KenFutWork 首页">
          {/* biome-ignore lint/performance/noImgElement: 独立 Vite 静态页使用本地品牌图片 */}
          <img src="./assets/logo-mark.png" alt="" width="44" height="44" />
          <span>KenFutWork</span>
        </a>
        <nav className="desktop-nav" aria-label="主导航">
          {navigation.map((item) => (
            <a
              key={item.label}
              href={item.href}
              target="_blank"
              rel="noreferrer"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <button
          className="header-download"
          type="button"
          onClick={openDownload}
        >
          下载 <ArrowDownToLine size={16} />
        </button>
        <button
          className="menu-button icon-button"
          type="button"
          aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? (
            <X size={27} strokeWidth={1.4} />
          ) : (
            <Menu size={27} strokeWidth={1.4} />
          )}
        </button>
      </header>
      {menuOpen && (
        <nav id="mobile-nav" className="mobile-nav" aria-label="移动导航">
          {navigation.map((item) => (
            <a
              key={item.label}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
              <ArrowUpRight size={17} />
            </a>
          ))}
          <button
            className="primary-button"
            type="button"
            onClick={openDownload}
          >
            下载 KenFutWork <ArrowDownToLine size={19} />
          </button>
        </nav>
      )}
      <main id="main" className="hero">
        <AnimatedTitle />
        <div className="hero-content">
          <p className="product-name">KenFutWork</p>
          <h1>你的 AI 工作台</h1>
          <p className="tagline">写代码 · 做设计 · 用自己的模型</p>
          <div className="hero-actions">
            <button
              className="primary-button"
              type="button"
              onClick={openDownload}
            >
              下载 KenFutWork <ArrowDownToLine size={21} strokeWidth={1.5} />
            </button>
            <button
              className="icon-button about-button"
              type="button"
              aria-label="了解 KenFutWork"
              onClick={() => setPanel("product")}
            >
              <ArrowUpRight size={24} strokeWidth={1.4} />
            </button>
          </div>
          <p className="hero-note">本地优先 / 自选模型 / 开源</p>
        </div>
      </main>
      <footer className="footer">
        <div>
          <p>© 2026 KenFutWork</p>
          <p className="footer-motto">YOUR MODELS. YOUR WORK.</p>
        </div>
        <a
          href={`${repositoryUrl}/blob/main/LICENSE`}
          target="_blank"
          rel="noreferrer"
        >
          OPEN SOURCE <span>GPL-3.0</span> <ArrowUpRight size={14} />
        </a>
      </footer>
      {panel && (
        <Dialog
          title={
            panel === "download" ? "下载 KenFutWork" : "一个工作台，无限可能"
          }
          onClose={() => setPanel(null)}
        >
          {panel === "download" ? <DownloadPanel /> : <ProductPanel />}
        </Dialog>
      )}
    </div>
  );
}
