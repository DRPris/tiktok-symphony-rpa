"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, SectionTitle, Empty } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api } from "@/lib/api";
import type { Product, Paginated } from "@/lib/types";
import { formatTime, modeLabel, cn } from "@/lib/utils";

const MODES = [
  { v: "image_to_video", label: "图生视频" },
  { v: "text_to_video", label: "文生视频" },
  { v: "ai_avatar", label: "AI 数字人" },
  { v: "remix", label: "Remix" },
];

const LANGS = ["zh", "en", "id", "th", "ph"];

export default function ProductsPage() {
  const [data, setData] = useState<Paginated<Product>>({
    items: [],
    total: 0,
    page: 1,
    per_page: 20,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState<null | "create" | { id: string }>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api<Paginated<Product>>("/products", {
        query: { page, per_page: 20 },
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
  }, [page]);

  const onUpload = async (file: File) => {
    setUploadStatus("上传中…");
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api("/products/upload-csv", { method: "POST", body: fd });
      setUploadStatus("上传成功");
      load();
      setTimeout(() => setUploadStatus(null), 2000);
    } catch (e: any) {
      setUploadStatus(`失败：${e.message}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("确认删除该产品？")) return;
    try {
      await api(`/products/${id}`, { method: "DELETE" });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const openCreate = () => {
    setEditing({
      id: "",
      name: "",
      mode: "image_to_video",
      url: "",
      prompt: "",
      language: "zh",
    });
    setShowForm("create");
  };

  const openEdit = (p: Product) => {
    setEditing({ ...p });
    setShowForm({ id: p.id });
  };

  const onSubmit = async () => {
    if (!editing) return;
    try {
      if (showForm === "create") {
        await api("/products", { method: "POST", body: editing });
      } else if (showForm && "id" in showForm) {
        await api(`/products/${showForm.id}`, {
          method: "PUT",
          body: editing,
        });
      }
      setShowForm(null);
      setEditing(null);
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / data.per_page));

  return (
    <div className="space-y-8">
      {/* Action bar */}
      <Panel className="p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="label-eyebrow">CATALOG / 共</span>
          <span className="num text-bone text-[18px]">{data.total}</span>
          <span className="label-eyebrow">件</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
          {uploadStatus && (
            <span className="text-[10px] font-mono uppercase tracking-widest2 text-amber mr-2">
              {uploadStatus}
            </span>
          )}
          <a href="/api/products/sample-csv" className="btn btn-ghost btn-sm">
            ↓ 示例 CSV
          </a>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => fileRef.current?.click()}
          >
            ⇪ 上传 CSV
          </button>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            + 添加产品
          </button>
        </div>
      </Panel>

      {error && (
        <div className="panel p-4 border-ember/30 text-ember text-[12px] font-mono">
          ⚠ {error}
        </div>
      )}

      <Panel noPadding className="overflow-hidden">
        {data.items.length === 0 ? (
          <Empty
            text={loading ? "加载中…" : "尚未添加任何产品"}
            hint="上传 CSV 或手动添加，开始你的第一个乐章。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head w-12">#</th>
                  <th className="table-head">产品名</th>
                  <th className="table-head">模式</th>
                  <th className="table-head">URL / 图片</th>
                  <th className="table-head">Prompt</th>
                  <th className="table-head w-20">语言</th>
                  <th className="table-head w-32">创建时间</th>
                  <th className="table-head w-32 text-right pr-6">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p, i) => (
                  <tr
                    key={p.id}
                    className="border-b border-ink-400/40 last:border-0 hover:bg-ink-200/40 transition-colors group"
                  >
                    <td className="table-cell num text-ink-700">
                      {String((page - 1) * data.per_page + i + 1).padStart(
                        3,
                        "0"
                      )}
                    </td>
                    <td className="table-cell text-bone font-medium max-w-[260px]">
                      <span className="line-clamp-1">{p.name}</span>
                    </td>
                    <td className="table-cell">
                      <span className="pill border-ink-500 text-ink-800 bg-ink-200/30">
                        {modeLabel(p.mode)}
                      </span>
                    </td>
                    <td className="table-cell text-ink-800 font-mono text-[11px] max-w-[260px]">
                      <span className="line-clamp-1">
                        {p.url || p.image || "—"}
                      </span>
                    </td>
                    <td className="table-cell text-ink-800 max-w-[280px]">
                      <span className="line-clamp-1 italic">
                        {p.prompt || "—"}
                      </span>
                    </td>
                    <td className="table-cell num text-ink-800 uppercase">
                      {p.language || "—"}
                    </td>
                    <td className="table-cell num text-ink-700">
                      {formatTime(p.created_at)}
                    </td>
                    <td className="table-cell text-right pr-6">
                      <div className="inline-flex items-center gap-1 opacity-50 group-hover:opacity-100 transition">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(p)}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => onDelete(p.id)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Pagination */}
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
        open={!!showForm}
        onClose={() => {
          setShowForm(null);
          setEditing(null);
        }}
        title={showForm === "create" ? "添加新产品" : "编辑产品"}
        caption="填写产品信息以加入生成队列"
        footer={
          <>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowForm(null);
                setEditing(null);
              }}
            >
              取消
            </button>
            <button className="btn btn-primary btn-sm" onClick={onSubmit}>
              保存
            </button>
          </>
        }
      >
        {editing && (
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="field-label">产品名 / NAME</label>
              <input
                className="input"
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
                placeholder="例如：智能保温水杯 500ml"
              />
            </div>
            <div>
              <label className="field-label">模式 / MODE</label>
              <select
                className="input"
                value={editing.mode}
                onChange={(e) =>
                  setEditing({ ...editing, mode: e.target.value as any })
                }
              >
                {MODES.map((m) => (
                  <option key={m.v} value={m.v}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">语言 / LANG</label>
              <select
                className="input"
                value={editing.language || "zh"}
                onChange={(e) =>
                  setEditing({ ...editing, language: e.target.value })
                }
              >
                {LANGS.map((l) => (
                  <option key={l} value={l}>
                    {l.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="field-label">URL / 图片地址</label>
              <input
                className="input"
                value={editing.url || ""}
                onChange={(e) =>
                  setEditing({ ...editing, url: e.target.value })
                }
                placeholder="https://..."
              />
            </div>
            <div className="col-span-2">
              <label className="field-label">PROMPT</label>
              <textarea
                className="input min-h-[110px] py-2 leading-relaxed"
                value={editing.prompt || ""}
                onChange={(e) =>
                  setEditing({ ...editing, prompt: e.target.value })
                }
                placeholder="描述视频内容方向…"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
