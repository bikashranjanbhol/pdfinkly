import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";
import { FileList } from "@/components/FileList";

export const metadata: Metadata = { title: "My files" };
export const dynamic = "force-dynamic";

export default function FilesPage() {
  return (
    <div className="min-h-screen bg-ground">
      <AppHeader active="files" />
      <FileList />
    </div>
  );
}
