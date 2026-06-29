"use client";

import { useEffect, useState } from "react";
import { StatCard } from "@/components/stat-card";
import { Panel, SectionTitle, Empty, HBar } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import {
  formatNum,
  formatPct,
  formatDuration,
  formatTime,
  modeLabel,
} from "@/lib/utils";
import { api } from "@/lib/api";
import type { DashboardStats, Task } from "@/lib/types";

const FALLBACK: DashboardStats = {
  today_total: 0,
  today_success: 0,
  today_failed: 0,
  success_rate: 0,
  queue: { pending: 0, running: 0, done: 0 },
  recent: [],
};

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>(FALLBACK);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await api<DashboardStats>("/dashboard/stats");
        if (alive) {
          setStats({ ...FALLBACK, ...data });
          setError(null);
        }
      } catch (e: any) {
        if (alive) setError(e.message || "无法连接到后端");
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="space-y-10">
      {/* Editorial intro strip */}
      <div className="flex items-stretch gap-6 -mt-2">
        <div className="flex-1 panel p-6 relative overflow-hidden">
          <div className="absolute inset-0 bg-noise opacity-40 pointer-events-none" />
          <div className="relative flex items-end justify-between gap-8">
            <div>
              <div className="label-eyebrow mb-2">PROLOGUE / 序章</div>
              <p className="text-[18px] font-display italic text-bone leading-snug max-w-[560px]">
                “一切交付都从一段静默开始。Symphony 在后台管弦着每一个像素的运转。”
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="num text-[42px] leading-none text-lime tracking-tightest">
                {String(new Date().getDate()).padStart(2, "0")}
              </div>
              <div className="label-eyebrow mt-2">
                {new Date().toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="panel p-4 border-ember/30 text-ember text-[12px] font-mono">
          ⚠ {error}
        </div>
      )}

      {/* 4 stat cards */}
      <section>
        <SectionTitle
          eyebrow="01 / KPI"
          title="Today's Pulse"
          caption="今日实时关键指标"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            eyebrow="今日总生成"
            label="Total Generations"
            value={formatNum(stats.today_total)}
            accent="lime"
            glyph="◆"
            index={0}
          />
          <StatCard
            eyebrow="成功"
            label="Successful"
            value={formatNum(stats.today_success)}
            accent="mint"
            glyph="▲"
            index={1}
          />
          <StatCard
            eyebrow="失败"
            label="Failed"
            value={formatNum(stats.today_failed)}
            accent="ember"
            glyph="▼"
            index={2}
          />
          <StatCard
            eyebrow="成功率"
            label="Success Rate"
            value={formatPct(stats.success_rate)}
            accent="amber"
            glyph="∿"
            index={3}
          />
        </div>
      </section>

      {/* Queue status */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel className="lg:col-span-1 p-6">
          <SectionTitle
            eyebrow="02 / QUEUE"
            title="Live Queue"
            caption="任务队列态势"
          />
          <div className="space-y-4">
            <HBar
              segments={[
                {
                  value: stats.queue.pending,
                  color: "bg-ink-700",
                  label: "待处理",
                },
                {
                  value: stats.queue.running,
                  color: "bg-sky",
                  label: "进行中",
                },
                {
                  value: stats.queue.done,
                  color: "bg-mint",
                  label: "已完成",
                },
              ]}
            />
            <div className="hairline" />
            <div className="grid grid-cols-3 gap-2 pt-2">
              {[
                {
                  k: "PENDING",
                  v: stats.queue.pending,
                  cls: "text-ink-800",
                },
                { k: "RUNNING", v: stats.queue.running, cls: "text-sky" },
                { k: "DONE", v: stats.queue.done, cls: "text-mint" },
              ].map((q) => (
                <div key={q.k} className="border-l border-ink-400 pl-3">
                  <div className="label-eyebrow">{q.k}</div>
                  <div className={`num text-[26px] mt-1 ${q.cls}`}>
                    {formatNum(q.v)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel className="lg:col-span-2 p-6">
          <SectionTitle
            eyebrow="03 / TIMELINE"
            title="Activity Strip"
            caption="过去一小时事件流（示意）"
          />
          <div className="relative h-32 border border-ink-400 rounded-xs overflow-hidden bg-ink-50">
            <div className="absolute inset-0 bg-grid bg-[size:24px_24px] opacity-40" />
            <div className="absolute inset-0 flex items-end gap-[2px] px-2 pb-2">
              {Array.from({ length: 60 }).map((_, i) => {
                const seed = (i * 37 + 11) % 100;
                const h = 12 + (seed * 0.7);
                const failed = seed > 88;
                return (
                  <div
                    key={i}
                    className={`flex-1 ${
                      failed ? "bg-ember/70" : i % 9 === 0 ? "bg-lime" : "bg-sky/60"
                    } transition-all hover:brightness-150`}
                    style={{ height: `${h}%` }}
                  />
                );
              })}
            </div>
            <div className="absolute top-2 left-3 label-eyebrow">— 60 MIN</div>
            <div className="absolute top-2 right-3 label-eyebrow text-bone">NOW</div>
          </div>
        </Panel>
      </section>

      {/* Recent tasks */}
      <section>
        <SectionTitle
          eyebrow="04 / RECENT"
          title="Latest Movements"
          caption="最近 10 条任务"
        />
        <Panel noPadding className="overflow-hidden">
          {stats.recent.length === 0 ? (
            <Empty
              text={loading ? "加载中…" : "暂无任务"}
              hint="等等，乐章尚未开始演奏。"
            />
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head w-12">#</th>
                  <th className="table-head">产品</th>
                  <th className="table-head">模式</th>
                  <th className="table-head">状态</th>
                  <th className="table-head">耗时</th>
                  <th className="table-head text-right pr-6">时间</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.slice(0, 10).map((t: Task, i) => (
                  <tr
                    key={t.id || i}
                    className="border-b border-ink-400/40 last:border-0 hover:bg-ink-200/40 transition-colors"
                  >
                    <td className="table-cell num text-ink-700">
                      {String(i + 1).padStart(2, "0")}
                    </td>
                    <td className="table-cell text-bone">
                      <span className="line-clamp-1">{t.product_name}</span>
                    </td>
                    <td className="table-cell text-ink-800 font-mono text-[11px] uppercase tracking-widest2">
                      {modeLabel(t.mode)}
                    </td>
                    <td className="table-cell">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="table-cell num text-ink-800">
                      {formatDuration(t.duration)}
                    </td>
                    <td className="table-cell num text-ink-700 text-right pr-6">
                      {formatTime(t.finished_at || t.started_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </section>
    </div>
  );
}
