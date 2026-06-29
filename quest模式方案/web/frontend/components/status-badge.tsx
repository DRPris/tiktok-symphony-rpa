import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/lib/types";

const MAP: Record<TaskStatus, { label: string; cls: string; dot: string }> = {
  pending: {
    label: "待处理",
    cls: "border-ink-600 text-ink-800 bg-ink-200/50",
    dot: "bg-ink-700",
  },
  running: {
    label: "执行中",
    cls: "border-sky/40 text-sky bg-sky-soft",
    dot: "bg-sky animate-pulse-soft",
  },
  waiting: {
    label: "等待中",
    cls: "border-amber/40 text-amber bg-amber-soft",
    dot: "bg-amber",
  },
  done: {
    label: "已完成",
    cls: "border-mint/40 text-mint bg-mint-soft",
    dot: "bg-mint",
  },
  failed: {
    label: "失败",
    cls: "border-ember/40 text-ember bg-ember-soft",
    dot: "bg-ember",
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: TaskStatus | string;
  className?: string;
}) {
  const m = MAP[(status as TaskStatus) in MAP ? (status as TaskStatus) : "pending"];
  return (
    <span className={cn("pill", m.cls, className)}>
      <span className={cn("w-1 h-1 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}
