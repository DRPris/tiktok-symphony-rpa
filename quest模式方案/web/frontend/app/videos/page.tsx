"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, SectionTitle, Empty } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api } from "@/lib/api";
import type { Video, Paginated } from "@/lib/types";
import {
  cn,
  formatBytes,
  formatDuration,
  formatTime,
  modeLabel,
} from "@/lib/utils";

const MODE_FILTERS = [
  { v: "all", label: "全部" },
  { v: "image_to_video", label: "图生视频" },
  { v: "text_to_video", label: "文生视频" },
  { v: "ai_avatar", label: "AI 数字人" },
  { v: "remix", label: "Remix" },
];

const DATE_FILTERS = [
  { v: "all", label: "全部时间" },
  { v: "today", label: "今天" },
  { v: "week", label: "近 7 天" },
  { v: "month", label: "近 30 天" },
];

export default function VideosPage() {
  const [data, setData] = useState<Paginated<Video>>({
    items: [],
    total: 0,
    page: 1,
    per_page: 20,
  });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState("all");
  const [date, setDate] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api<Paginated<Video>>("/videos", {
        query: { page, per_page: 20, mode, date },
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
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, mode, date]);

  const allSelected = useMemo(
    () => data.items.length > 0 && data.items.every((v) => selected.has(v.id)),
    [data.items, selected]
  );

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(data.items.map((v) => v.id)));
  };

  const onDelete = async (id: string) => {
    if (!confirm("确认删除该视频？")) return;
    try {
      await api(`/videos/${id}`, { method: "DELETE" });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const onBatchDownload = async () => {
    if (selected.size === 0) return alert("请选择视频");
    try {
      const res = await fetch("/api/videos/batch-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) throw new Error("下载失败");
      const blob = await res.blob();
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `symphony_videos_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / data.per_page));

  return (
    <div className="space-y-8">
      {/* Filter bar */}
      <Panel className="p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="label-eyebrow">MODE</span>
            <div className="flex items-center gap-1">
              {MODE_FILTERS.map((f) => (
                <button
                  key={f.v}
                  onClick={() => {
                    setMode(f.v);
                    setPage(1);
                  }}
                  className={cn(
                    "px-2.5 h-7 text-[10px] font-mono uppercase tracking-widest2 border rounded-xs transition-colors",
                    mode === f.v
                      ? "bg-bone text-ink-0 border-bone"
                      : "bg-transparent text-ink-800 border-ink-500 hover:border-ink-700 hover:text-bone"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <span className="w-px h-6 bg-ink-500" />
          <div className="flex items-center gap-2">
            <span className="label-eyebrow">DATE</span>
            <div className="flex items-center gap-1">
              {DATE_FILTERS.map((f) => (
                <button
                  key={f.v}
                  onClick={() => {
                    setDate(f.v);
                    setPage(1);
                  }}
                  className={cn(
                    "px-2.5 h-7 text-[10px] font-mono uppercase tracking-widest2 border rounded-xs transition-colors",
                    date === f.v
                      ? "bg-bone text-ink-0 border-bone"
                      : "bg-transparent text-ink-800 border-ink-500 hover:border-ink-700 hover:text-bone"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="label-eyebrow">
            选中 <span className="num text-bone">{selected.size}</span>
          </span>
          <button
            className={cn(
              "btn btn-ghost btn-sm",
              data.items.length === 0 && "opacity-30 pointer-events-none"
            )}
            onClick={toggleAll}
          >
            {allSelected ? "□ 取消" : "▣ 全选"}
          </button>
          <button
            className={cn(
              "btn btn-primary btn-sm",
              selected.size === 0 && "opacity-40 pointer-events-none"
            )}
            onClick={onBatchDownload}
          >
            ⇩ 批量下载 ZIP
          </button>
        </div>
      </Panel>

      {error && (
        <div className="panel p-4 border-ember/30 text-ember text-[12px] font-mono">
          ⚠ {error}
        </div>
      )}

      {data.items.length === 0 ? (
        <Panel>
          <Empty
            text={loading ? "加载中…" : "尚无视频"}
            hint="启动批量任务，让乐章奏响。"
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {data.items.map((v, i) => (
            <VideoCard
              key={v.id}
              v={v}
              index={i}
              checked={selected.has(v.id)}
              onToggle={() => toggle(v.id)}
              onPreview={() => setPreview(v)}
              onDelete={() => onDelete(v.id)}
            />
          ))}
        </div>
      )}

      {data.total > 0 && (
        <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-widest2 text-ink-700">
          <span>
            PAGE <span className="num text-bone">{page}</span> /{" "}
            <span className="num">{totalPages}</span> · TOTAL{" "}
            <span className="num text-bone">{data.total}</span>
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

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.name || "预览"}
        caption={preview ? modeLabel(preview.mode) : undefined}
        size="lg"
        footer={
          preview && (
            <a
              href={`/api/videos/${preview.id}/download`}
              download
              className="btn btn-primary btn-sm"
            >
              ⇩ 下载视频
            </a>
          )
        }
      >
        {preview && (
          <div>
            <div className="aspect-video w-full bg-ink-0 border border-ink-400 rounded-xs overflow-hidden">
              <video
                key={preview.id}
                src={preview.url}
                controls
                autoPlay
                className="w-full h-full"
              />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 text-[11px] font-mono uppercase tracking-widest2">
              <div>
                <div className="label-eyebrow">DURATION</div>
                <div className="num text-bone mt-1">
                  {formatDuration(preview.duration)}
                </div>
              </div>
              <div>
                <div className="label-eyebrow">SIZE</div>
                <div className="num text-bone mt-1">
                  {formatBytes(preview.size)}
                </div>
              </div>
              <div>
                <div className="label-eyebrow">CREATED</div>
                <div className="num text-bone mt-1">
                  {formatTime(preview.created_at)}
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function VideoCard({
  v,
  index,
  checked,
  onToggle,
  onPreview,
  onDelete,
}: {
  v: Video;
  index: number;
  checked: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "panel relative overflow-hidden group animate-fade-up",
        checked && "border-lime/60 shadow-accent"
      )}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* thumb */}
      <button
        type="button"
        onClick={onPreview}
        className="block w-full aspect-[9/16] relative bg-ink-0 overflow-hidden"
      >
        {v.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={v.thumbnail}
            alt={v.name}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="absolute inset-0 bg-grid bg-[size:24px_24px] opacity-40" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-ink-0/90 via-transparent to-transparent" />
        <div className="absolute top-2 left-2 flex items-center gap-1.5">
          <span className="pill border-bone/30 bg-ink-0/60 text-bone backdrop-blur">
            {modeLabel(v.mode)}
          </span>
        </div>
        <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between">
          <span className="num text-[10px] text-bone/80">
            {formatDuration(v.duration)}
          </span>
          <span className="num text-[10px] text-bone/80">
            {formatBytes(v.size)}
          </span>
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full border-2 border-bone bg-ink-0/40 backdrop-blur-md flex items-center justify-center">
            <span className="text-bone text-lg ml-0.5">▶</span>
          </div>
        </div>
      </button>

      <div className="p-3 border-t border-ink-400/60 flex items-center gap-2">
        <button
          onClick={onToggle}
          className={cn(
            "w-4 h-4 border rounded-xs flex items-center justify-center text-[10px] shrink-0",
            checked
              ? "bg-lime border-lime text-ink-0"
              : "border-ink-500 text-transparent hover:border-ink-700"
          )}
        >
          ✓
        </button>
        <span className="flex-1 text-[12px] text-bone line-clamp-1">
          {v.name}
        </span>
        <a
          href={`/api/videos/${v.id}/download`}
          download
          className="text-[10px] font-mono uppercase tracking-widest2 text-ink-700 hover:text-bone"
          title="下载"
        >
          ⇩
        </a>
        <button
          onClick={onDelete}
          className="text-[10px] font-mono uppercase tracking-widest2 text-ink-700 hover:text-ember"
          title="删除"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
