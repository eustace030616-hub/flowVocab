import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "My App",
  description: "Built with Next.js + Hono + MongoDB",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
