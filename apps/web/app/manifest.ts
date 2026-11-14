import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PDFInkly",
    short_name: "PDFInkly",
    description: "Edit, sign and organize PDFs in your browser.",
    start_url: "/files",
    display: "standalone",
    background_color: "#FAFAF9",
    theme_color: "#2563EB",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
