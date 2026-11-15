import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";
import { Scanner } from "@/components/scan/Scanner";

export const metadata: Metadata = {
  title: "Scan documents",
  description: "Turn phone photos of documents into clean, scanned-looking PDFs: automatic cropping, straightening and shadow removal, in your browser.",
};

export default function ScanPage() {
  return (
    <div className="min-h-screen bg-ground">
      <AppHeader active="scan" />
      <Scanner />
    </div>
  );
}
