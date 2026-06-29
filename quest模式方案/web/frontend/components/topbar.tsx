"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TITLES: Record<string, { zh: string; en: string; meta: string }> = {
  "/": { zh: "仪表盘", en: "Mission Control", meta: "实时态势 / Live Overview" },
  "/products": { zh: "产品管理", en: "Product Catalog", meta: "Catalog · CRUD" },
  "/tasks": { zh: "批量任务", en: "Task Orchestrator", meta: "Queue · Runtime" },
  "/videos": { zh: "视频库", en: "Asset Library", meta: "Renders · Archive" },
  "/settings": { zh: "设置", en: "System Settings", meta: "Runtime · Config" },
};

export function Topbar() {
  const pathname = usePathname();
  const t = TITLES[pathname] || TITLES["/"];
  const [now, setNow] = useState<string>("--:--:--");

  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    setNow(fmt());
    const id = setInterval(() => setNow(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="px-10 pt-9 pb-6 border-b border-ink-400/40 relative overflow-hidden">
      <div className="absolute -top-20 -right-10 w-[480px] h-[200px] bg-grid bg-[size:32px_32px] opacity-30 pointer-events-none" />
      <div className="relative flex items-end justify-between gap-8">
        <div>
          <div className="label-eyebrow flex items-center gap-3">
            <span className="num">{t.meta}</span>
            <span className="w-8 h-px bg-ink-500" />
            <span className="text-lime">●</span>
          </div>
          <h1 className="mt-3 flex items-baseline gap-4">
            <span className="text-[44px] leading-[1] font-display italic tracking-tightest text-bone">
              {t.en}
            </span>
            <span className="text-[18px] text-ink-800 font-light">/ {t.zh}</span>
          </h1>
        </div>
        <div className="flex flex-col items-end gap-2 text-right">
          <div className="num text-[11px] uppercase tracking-widest2 text-ink-700">
            <span className="text-bone">{now}</span>
            <span className="ml-2">UTC+8</span>
          </div>
          <div className="text-[10px] uppercase tracking-widest2 font-mono text-ink-700 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime animate-pulse-soft" />
            <span>实时连接 LIVE</span>
          </div>
        </div>
      </div>
    </header>
  );
}
