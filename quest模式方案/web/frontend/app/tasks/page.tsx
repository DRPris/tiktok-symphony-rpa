"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, SectionTitle, Empty } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import type {
  Task,
  TaskStatus,
  Paginated,
  ProgressEvent,
} from "@/lib/types";
import {
  cn,
  formatDuration,
  formatTime,
  modeLabel,
  statusLabel,
} from "@/lib/utils";

const FILTERS: { v: "all" | TaskStatus; label: string }[] = [
  { v: "all", label: "全部" },
  { v: "pending", label: "待处理" },
  { v: "running", label: "执行中" },
  { v: "done", label: "已完成" },
  { v: "failed", label: "失败" },
];

export default function TasksPage() {
  const [data, setData] = useState<Paginated<Task>>({
    items: [],
    total: 0,
    page: 1,
    per_page: 20,
  });
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api<Paginated<Task>>("/tasks", {
        query: { status: filter, page, per_page: 20 },
      });
      setData(r);
      setError(null);
    } catch (e: any) {
      setError(e.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filter]);

  // SSE: realtime progress
  useEffect(() => {
    const es = new EventSource("/api/tasks/progress");
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const data: ProgressEvent = JSON.parse(ev.data);
        setProgress(data);
        setRunning(true);
        // refresh table when a task finishes
        if (data.status === "done" || data.status === "failed") load();
      } catch {}
    };
    es.onerror = () => {
      // Connection might drop when engine idle
      setRunning(false);
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCreateBatch = async () => {
    if (!confirm("基于当前所有产品创建批量任务？")) return;
    try {
      await api("/tasks/batch", { method: "POST" });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const onStart = async () => {
    try {
      await api("/tasks/start", { method: "POST" });
      setRunning(true);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const onStop = async () => {
    try {
      await api("/tasks/stop", { method: "POST" });
      setRunning(false);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const onRetry = async (id: string) => {
    try {
      await api(`/tasks/${id}/retry`, { method: "POST" });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / data.per_page));
  const pct =
    progress && progress.total > 0
      ? Math.min(100, (progress.completed / progress.total) * 100)
      : 0;

  return (
    <div className="space-y-8">
      {/* Action bar */}
      <Panel className="p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="label-eyebrow">QUEUE / 共</span>
          <span className="num text-bone text-[18px]">{data.total}</span>
          <span className="label-eyebrow">条</span>

          <span className="w-px h-6 bg-ink-500 mx-2" />

          <div className="flex items-center gap-1 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.v}
                onClick={() => {
                  setFilter(f.v);
                  setPage(1);
                }}
                className={cn(
                  "px-3 h-7 text-[10px] font-mono uppercase tracking-widest2 border rounded-xs transition-colors",
                  filter === f.v
                    ? "bg-lime text-ink-0 border-lime"
                    : "bg-transparent text-ink-800 border-ink-500 hover:border-ink-700 hover:text-bone"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onCreateBatch}>
            + 创建批量任务
          </button>
          {running ? (
            <button className="btn btn-danger btn-sm" onClick={onStop}>
              ■ 停止执行
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={onStart}>
              ▶ 启动执行
            </button>
          )}
        </div>
      </Panel>

      {/* Realtime progress */}
      {running && progress && (
        <Panel className="p-5 relative overflow-hidden">
          <div className="absolute inset-0 bg-noise opacity-30 pointer-events-none" />
          <div className="relative">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="label-eyebrow flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-lime animate-pulse-soft" />
                  ENGINE LIVE
                </div>
                <div className="mt-1 text-[14px] text-bone font-display italic">
                  {progress.current || progress.message || "正在演奏…"}
                </div>
              </div>
              <div className="text-right">
                <div className="num text-[28px] text-lime tracking-tightest leading-none">
                  {pct.toFixed(1)}%
                </div>
                <div className="label-eyebrow mt-1">
                  <span className="num text-bone">{progress.completed}</span>
                  {" / "}
                  <span className="num">{progress.total}</span>
                </div>
              </div>
            </div>
            <div className="relative h-1.5 bg-ink-300 rounded-xs overflow-hidden">
              <div
                className="absolute top-0 left-0 h-full bg-lime transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
              <div
                className="absolute top-0 h-full w-1/4 glow-line"
                style={{
                  left: `${Math.max(0, pct - 12)}%`,
                  opacity: 0.7,
                }}
              />
            </div>
          </div>
        </Panel>
      )}

      {error && (
        <div className="panel p-4 border-ember/30 text-ember text-[12px] font-mono">
          ⚠ {error}
        </div>
      )}

      <Panel noPadding className="overflow-hidden">
        {data.items.length === 0 ? (
          <Empty
            text={loading ? "加载中…" : "暂无任务"}
            hint="创建批量任务以填充队列。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head w-12">#</th>
                  <th className="table-head">产品</th>
                  <th className="table-head">模式</th>
                  <th className="table-head w-24">状态</th>
                  <th className="table-head w-16 text-center">重试</th>
                  <th className="table-head">错误信息</th>
                  <th className="table-head w-20">耗时</th>
                  <th className="table-head w-24 text-right pr-6">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((t, i) => (
                  <tr
                    key={t.id}
                    className="border-b border-ink-400/40 last:border-0 hover:bg-ink-200/40 transition-colors group"
                  >
                    <td className="table-cell num text-ink-700">
                      {String((page - 1) * data.per_page + i + 1).padStart(
                        3,
                        "0"
                      )}
                    </td>
                    <td className="table-cell text-bone max-w-[260px]">
                      <span className="line-clamp-1">{t.product_name}</span>
                    </td>
                    <td className="table-cell text-ink-800 font-mono text-[11px] uppercase tracking-widest2">
                      {modeLabel(t.mode)}
                    </td>
                    <td className="table-cell">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="table-cell num text-center">
                      {t.retries > 0 ? (
                        <span className="text-amber">×{t.retries}</span>
                      ) : (
                        <span className="text-ink-700">—</span>
                      )}
                    </td>
                    <td className="table-cell text-ember/80 font-mono text-[11px] max-w-[280px]">
                      <span className="line-clamp-1">{t.error || "—"}</span>
                    </td>
                    <td className="table-cell num text-ink-800">
                      {formatDuration(t.duration)}
                    </td>
                    <td className="table-cell text-right pr-6">
                      {t.status === "failed" && (
                        <button
                          className="btn btn-ghost btn-sm opacity-60 group-hover:opacity-100"
                          onClick={() => onRetry(t.id)}
                        >
                          ↻ 重试
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {data.total > 0 && (
        <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-widest2 text-ink-700">
          <span>
            FILTER · <span className="text-bone">{statusLabel(filter)}</span> ·
            PAGE <span className="num text-bone">{page}</span> /{" "}
            <span className="num">{totalPages}</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              className={cn(
                "btn btn-ghost btn-sm",
                page === 1 && "opacity-30 pointer-events-none"
              )}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← PREV
            </button>
            <button
              className={cn(
                "btn btn-ghost btn-sm",
                page >= totalPages && "opacity-30 pointer-events-none"
              )}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              NEXT →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
