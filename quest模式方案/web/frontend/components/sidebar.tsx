"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "仪表盘", code: "01", en: "Dashboard" },
  { href: "/products", label: "产品管理", code: "02", en: "Products" },
  { href: "/tasks", label: "批量任务", code: "03", en: "Tasks" },
  { href: "/videos", label: "视频库", code: "04", en: "Library" },
  { href: "/settings", label: "设置", code: "05", en: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="fixed top-0 left-0 z-40 w-[240px] h-screen border-r border-ink-400/60 bg-ink-50/60 backdrop-blur-md flex flex-col">
      {/* logo block */}
      <div className="px-6 pt-7 pb-6 border-b border-ink-400/60 relative overflow-hidden">
        <div className="absolute inset-0 diag-stripes opacity-50 pointer-events-none" />
        <div className="relative">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl tracking-tightest font-display italic text-bone leading-none">
              Symphony
            </span>
            <span className="num text-[10px] text-lime">●</span>
          </div>
          <div className="mt-2 flex items-center gap-2 label-eyebrow">
            <span>批量视频控制台</span>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[9px] font-mono uppercase tracking-widest2 text-ink-700">
            <span className="num">v0.1.0</span>
            <span className="w-px h-3 bg-ink-500" />
            <span>BUILD 240603</span>
          </div>
        </div>
      </div>

      {/* nav */}
      <nav className="flex-1 px-3 py-6 space-y-1 overflow-y-auto">
        <div className="px-3 mb-3 label-eyebrow">导航 / NAV</div>
        {NAV.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group relative flex items-center gap-3 px-3 py-2.5 rounded-xs transition-all",
                active
                  ? "bg-ink-200 text-bone"
                  : "text-ink-800 hover:text-bone hover:bg-ink-200/50"
              )}
            >
              {active && (
                <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-lime" />
              )}
              <span
                className={cn(
                  "num text-[10px] tracking-widest2 transition-colors",
                  active ? "text-lime" : "text-ink-700 group-hover:text-ink-800"
                )}
              >
                {item.code}
              </span>
              <span className="flex-1 flex flex-col">
                <span className="text-[13.5px] font-medium leading-none">
                  {item.label}
                </span>
                <span className="mt-1 text-[9px] uppercase tracking-widest2 font-mono text-ink-700">
                  {item.en}
                </span>
              </span>
              <span
                className={cn(
                  "transition-transform text-[10px] font-mono",
                  active ? "text-lime translate-x-0" : "opacity-0 group-hover:opacity-60 group-hover:translate-x-0 -translate-x-1"
                )}
              >
                →
              </span>
            </Link>
          );
        })}
      </nav>

      {/* status block */}
      <div className="border-t border-ink-400/60 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="label-eyebrow">Engine</span>
          <span className="pill border-mint/30 text-mint bg-mint-soft">
            <span className="w-1 h-1 rounded-full bg-mint animate-pulse-soft" />
            IDLE
          </span>
        </div>
        <div className="text-[10px] font-mono text-ink-700 uppercase tracking-widest2">
          <div className="flex justify-between">
            <span>SESSION</span>
            <span className="text-bone">ACTIVE</span>
          </div>
          <div className="flex justify-between mt-1">
            <span>QUEUE</span>
            <span className="num text-bone">00</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
