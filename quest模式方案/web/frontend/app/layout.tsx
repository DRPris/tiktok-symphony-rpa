import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export const metadata: Metadata = {
  title: "Symphony · 批量视频控制台",
  description: "Symphony 批量视频生成控制台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans antialiased">
        <div className="relative min-h-screen flex">
          <Sidebar />
          <main className="flex-1 ml-[240px] flex flex-col min-h-screen">
            <Topbar />
            <div className="flex-1 px-10 pt-8 pb-16 max-w-[1480px] w-full">
              {children}
            </div>
            <footer className="px-10 py-6 border-t border-ink-400/60 flex items-center justify-between text-[10px] uppercase tracking-widest2 font-mono text-ink-700">
              <span>Symphony · v0.1 · build {new Date().getFullYear()}</span>
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-mint animate-pulse-soft" />
                System Operational
              </span>
            </footer>
          </main>
        </div>
      </body>
    </html>
  );
}
