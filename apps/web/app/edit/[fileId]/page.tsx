import type { Metadata } from "next";
import { Editor } from "@/components/editor/Editor";
import { getActor } from "@/lib/server/actor";

export const metadata: Metadata = { title: "Editor", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function EditPage({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const actor = await getActor().catch(() => null);
  return <Editor fileId={fileId} isGuest={!actor || actor.isGuest} />;
}
