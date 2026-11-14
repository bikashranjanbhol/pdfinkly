"use client";

import { api } from "@/lib/client/api";

export function DeleteAccountButton() {
  async function onClick() {
    if (!confirm("Delete your account and all your files? This can't be undone.")) return;
    await api("/api/me", { method: "DELETE" });
    window.location.href = "/";
  }
  return (
    <button type="button" onClick={onClick} className="btn-danger">Delete account</button>
  );
}
