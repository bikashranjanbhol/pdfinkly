import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: { default: "PDFInkly · Edit, sign and organize PDFs in your browser", template: "%s · PDFInkly" },
  description:
    "Free online PDF editor. Annotate, fill and sign, merge, rearrange and rotate pages. Editing happens in your browser, so your documents stay private.",
  openGraph: { siteName: "PDFInkly", type: "website" },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { themeColor: "#2563EB" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
        />
      </head>
      <body className="min-h-screen font-sans text-[15px] leading-normal">{children}</body>
    </html>
  );
}
