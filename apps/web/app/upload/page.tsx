import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";
import { Uploader } from "@/components/Uploader";

export const metadata: Metadata = { title: "Upload PDFs" };
export const dynamic = "force-dynamic";

export default function UploadPage() {
  return (
    <div className="min-h-screen bg-ground">
      <AppHeader active="upload" />
      <Uploader />
    </div>
  );
}
