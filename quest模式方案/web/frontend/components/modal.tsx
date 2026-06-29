"use client";

import { cn } from "@/lib/utils";
import { useEffect } from "react";

export function Modal({
  open,
  onClose,
  title,
  caption,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  caption?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const w = size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-ink-0/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative w-full panel shadow-panel animate-fade-up",
          w
        )}
      >
        <div className="px-6 pt-5 pb-4 border-b border-ink-400 flex items-start justify-between gap-6">
          <div>
            <div className="label-eyebrow mb-1">FORM</div>
            <h3 className="text-[20px] font-display italic tracking-tightest text-bone leading-none">
              {title}
            </h3>
            {caption && (
              <p className="mt-2 text-[12px] text-ink-800">{caption}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-ink-700 hover:text-bone text-xl leading-none"
            aria-label="close"
          >
            ×
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-ink-400 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
