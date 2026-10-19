import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "发给 AI 前，先保护隐私",
  description: "在把病历、检查报告和聊天记录发给 AI 前，先把姓名、电话、身份证号这些个人信息遮掉。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
