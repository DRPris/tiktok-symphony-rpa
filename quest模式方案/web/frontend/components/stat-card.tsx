"use client";

import { cn } from "@/lib/utils";

interface StatCardProps {
  eyebrow: string;
  label: string;
  value: string | number;
  delta?: { value: string; positive?: boolean };
  accent?: "lime" | "sky" | "ember" | "mint" | "amber";
  glyph?: string;
  index?: number;
}

const ACCENT: Record<NonNullable<StatCardProps["accent"]>, string> = {
  lime: "text-lime",
  sky: "text-sky",
  ember: "text-ember",
  mint: "text-mint",
  amber: "text-amber",
};

export function StatCard({
  eyebrow,
  label,
  value,
  delta,
  accent = "lime",
  glyph,
  index = 0,
}: StatCardProps) {
  return (
    <div
      className="panel relative overflow-hidden p-5 group hover:border-ink-500 transition-colors animate-fade-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="absolute top-0 right-0 w-24 h-24 bg-grid bg-[size:16px_16px] opacity-30 pointer-events-none" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-ink-600 to-transparent" />

      <div className="flex items-start justify-between">
        <span className="label-eyebrow">{eyebrow}</span>
        <span className={cn("num text-[10px]", ACCENT[accent])}>{glyph || "◇"}</span>
      </div>

      <div className="mt-5 flex items-baseline gap-2">
        <span className="num text-[42px] leading-none font-medium text-bone tracking-tightest">
          {value}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-ink-800">{label}</span>
        {delta && (
          <span
            className={cn(
              "num text-[10px] font-mono px-1.5 py-0.5 rounded-xs",
              delta.positive
                ? "text-mint bg-mint-soft"
                : "text-ember bg-ember-soft"
            )}
          >
            {delta.positive ? "▲" : "▼"} {delta.value}
          </span>
        )}
      </div>

      {/* hover scan-line */}
      <div className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
        <div className="h-full w-1/3 glow-line opacity-0 group-hover:opacity-100 group-hover:animate-scan" />
      </div>
    </div>
  );
}
