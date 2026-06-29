"use client";

import { useEffect, useState } from "react";
import { Panel, SectionTitle } from "@/components/ui";
import { api } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const DEFAULTS: Settings = {
  max_concurrent_tabs: 2,
  video_timeout_seconds: 600,
  poll_interval_seconds: 10,
  delay_min: 1,
  delay_max: 3,
  output_dir: "symphony_batch/output",
  session_active: false,
};

export default function SettingsPage() {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [sessionMsg, setSessionMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api<Settings>("/settings");
      setS({ ...DEFAULTS, ...r });
      setError(null);
    } catch (e: any) {
      setError(e.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      await api("/settings", { method: "PUT", body: s });
      setSavedAt(new Date().toLocaleTimeString("en-US", { hour12: false }));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const onCheckSession = async () => {
    setSessionMsg("检查中…");
    try {
      const r = await api<{ active: boolean; message?: string }>(
        "/settings/check-session",
        { method: "POST" }
      );
      setS((prev) => ({ ...prev, session_active: r.active }));
      setSessionMsg(r.active ? "登录态有效 ✓" : r.message || "登录态失效");
    } catch (e: any) {
      setSessionMsg(`检查失败：${e.message}`);
    }
  };

  const onRelogin = async () => {
    if (!confirm("将打开浏览器进行重新登录，确认继续？")) return;
    try {
      await api("/settings/relogin", { method: "POST" });
      setSessionMsg("已触发重新登录，请在浏览器中完成。");
    } catch (e: any) {
      setSessionMsg(`失败：${e.message}`);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Left: Form */}
      <div className="xl:col-span-2 space-y-6">
        <Panel className="p-6">
          <SectionTitle
            eyebrow="01 / RUNTIME"
            title="Engine Parameters"
            caption="批量执行的运行时参数。修改后请保存。"
          />

          <div className="space-y-7">
            {/* Concurrent tabs slider */}
            <div>
              <div className="flex items-end justify-between mb-3">
                <label className="field-label !mb-0">
                  最大并发标签页数 / MAX TABS
                </label>
                <span className="num text-[24px] text-lime tracking-tightest leading-none">
                  {s.max_concurrent_tabs.toString().padStart(2, "0")}
                </span>
              </div>
              <Slider
                value={s.max_concurrent_tabs}
                min={1}
                max={5}
                onChange={(v) =>
                  setS({ ...s, max_concurrent_tabs: v })
                }
              />
              <div className="flex justify-between mt-1 num text-[10px] text-ink-700 uppercase tracking-widest2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
            </div>

            <div className="hairline" />

            <div className="grid grid-cols-2 gap-5">
              <NumberField
                label="视频生成超时（秒） / TIMEOUT"
                value={s.video_timeout_seconds}
                min={30}
                max={3600}
                onChange={(v) => setS({ ...s, video_timeout_seconds: v })}
              />
              <NumberField
                label="轮询间隔（秒） / POLL"
                value={s.poll_interval_seconds}
                min={1}
                max={60}
                onChange={(v) => setS({ ...s, poll_interval_seconds: v })}
              />
              <NumberField
                label="操作延迟最小值 / DELAY MIN"
                value={s.delay_min}
                min={0}
                max={30}
                step={0.5}
                onChange={(v) => setS({ ...s, delay_min: v })}
              />
              <NumberField
                label="操作延迟最大值 / DELAY MAX"
                value={s.delay_max}
                min={0}
                max={30}
                step={0.5}
                onChange={(v) => setS({ ...s, delay_max: v })}
              />
            </div>

            <div className="hairline" />

            <div>
              <label className="field-label">输出目录 / OUTPUT DIR</label>
              <input
                className="input font-mono"
                value={s.output_dir}
                onChange={(e) => setS({ ...s, output_dir: e.target.value })}
                placeholder="symphony_batch/output"
              />
              <p className="mt-2 text-[11px] text-ink-700 font-mono">
                视频将按国家代码分目录存放于此路径下。
              </p>
            </div>
          </div>
        </Panel>

        <div className="flex items-center justify-between">
          <div className="text-[11px] font-mono uppercase tracking-widest2 text-ink-700">
            {savedAt ? (
              <span className="text-mint">✓ 已保存 · {savedAt}</span>
            ) : (
              <span>修改后请点击保存</span>
            )}
            {error && (
              <span className="ml-3 text-ember">⚠ {error}</span>
            )}
          </div>
          <button
            className={cn(
              "btn btn-primary",
              saving && "opacity-60 pointer-events-none"
            )}
            onClick={onSave}
          >
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
      </div>

      {/* Right: Session */}
      <div className="space-y-6">
        <Panel className="p-6">
          <SectionTitle
            eyebrow="02 / SESSION"
            title="Auth State"
            caption="Symphony 平台登录态"
          />

          <div className="relative panel p-5 overflow-hidden">
            <div className="absolute inset-0 diag-stripes opacity-50 pointer-events-none" />
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <span className="label-eyebrow">CURRENT</span>
                <span
                  className={cn(
                    "pill",
                    s.session_active
                      ? "border-mint/40 text-mint bg-mint-soft"
                      : "border-ember/40 text-ember bg-ember-soft"
                  )}
                >
                  <span
                    className={cn(
                      "w-1 h-1 rounded-full",
                      s.session_active
                        ? "bg-mint animate-pulse-soft"
                        : "bg-ember"
                    )}
                  />
                  {s.session_active ? "ACTIVE" : "EXPIRED"}
                </span>
              </div>
              <div className="font-display italic text-[26px] text-bone leading-tight">
                {s.session_active ? "登录态有效" : "需要重新登录"}
              </div>
              {sessionMsg && (
                <div className="mt-3 text-[11px] font-mono text-ink-800 uppercase tracking-widest2">
                  {sessionMsg}
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <button className="btn btn-ghost" onClick={onCheckSession}>
              ↻ 检查登录态
            </button>
            <button className="btn btn-primary" onClick={onRelogin}>
              ⎘ 重新登录
            </button>
          </div>
        </Panel>

        <Panel className="p-6">
          <SectionTitle
            eyebrow="03 / NOTES"
            title="Memo"
            caption="给未来的自己一些线索。"
          />
          <ul className="space-y-3 text-[12px] text-ink-800 leading-relaxed">
            <li className="flex gap-2">
              <span className="num text-lime shrink-0">01.</span>
              <span>并发数上调会显著提升速度，但容易触发风控。</span>
            </li>
            <li className="flex gap-2">
              <span className="num text-lime shrink-0">02.</span>
              <span>视频超时建议保持 ≥ 600 秒，避免长视频任务被中断。</span>
            </li>
            <li className="flex gap-2">
              <span className="num text-lime shrink-0">03.</span>
              <span>操作延迟随机化能降低被识别为脚本的概率。</span>
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <input
        type="number"
        className="input num"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative h-8 flex items-center">
      <div className="absolute inset-x-0 h-1 bg-ink-300 rounded-xs" />
      <div
        className="absolute h-1 bg-lime rounded-xs"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute w-4 h-4 -translate-x-1/2 bg-bone border-2 border-lime rounded-full shadow-accent pointer-events-none"
        style={{ left: `${pct}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="absolute inset-0 w-full opacity-0 cursor-pointer"
      />
    </div>
  );
}
