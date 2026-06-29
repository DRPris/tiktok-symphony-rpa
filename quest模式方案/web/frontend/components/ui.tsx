"use client";

import { cn } from "@/lib/utils";

export function SectionTitle({
  eyebrow,
  title,
  caption,
  right,
  className,
}: {
  eyebrow?: string;
  title: string;
  caption?: string;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-end justify-between gap-6 mb-5",
        className
      )}
    >
      <div>
        {eyebrow && <div className="label-eyebrow mb-2">{eyebrow}</div>}
        <h2 className="text-[22px] font-display italic tracking-tightest text-bone leading-none">
          {title}
        </h2>
        {caption && (
          <p className="mt-2 text-[12px] text-ink-800">{caption}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Panel({
  children,
  className,
  noPadding,
}: {
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
}) {
  return (
    <div className={cn("panel", !noPadding && "p-5", className)}>{children}</div>
  );
}

export function Empty({
  text = "暂无数据",
  hint,
}: {
  text?: string;
  hint?: string;
}) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="font-display italic text-[28px] text-ink-700 leading-none mb-2">
        nothing here
      </div>
      <div className="label-eyebrow mb-3">{text}</div>
      {hint && <div className="text-[12px] text-ink-800">{hint}</div>}
    </div>
  );
}

export function HBar({
  segments,
  className,
}: {
  segments: { value: number; color: string; label?: string }[];
  className?: string;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className={cn("w-full", className)}>
      <div className="flex h-2 w-full rounded-xs overflow-hidden border border-ink-400">
        {segments.map((s, i) => (
          <div
            key={i}
            className={s.color}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={s.label}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[10px] font-mono uppercase tracking-widest2 text-ink-800">
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-xs", s.color)} />
            {s.label} <span className="num text-bone">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
