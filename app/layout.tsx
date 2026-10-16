import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flowwing",
  description: "Read passages pitched at your level, and mark the words you do not know.",
  // Installed to the home screen, the app opens without browser chrome — which matters on a phone,
  // where the reading area is the whole point.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Flowwing" },
  icons: { icon: "/icon-192.png", apple: "/icon-180.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the layout extend under the notch and the home indicator, which the CSS then insets away
  // from deliberately rather than the browser shrinking the whole page.
  viewportFit: "cover",
  themeColor: "#fafafa",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans bg-white text-zinc-900">
        {/* If the client never runs, the reader shows an empty shell and looks broken — which is
            exactly how a blocked JavaScript bundle presents on a phone. Say so instead of leaving a
            blank page to interpret. */}
        <noscript>
          <div className="p-6 text-sm text-zinc-600">
            Flowwing needs JavaScript to show a passage. If you are seeing this, the page loaded but
            its scripts did not — check that the server allows this address.
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
