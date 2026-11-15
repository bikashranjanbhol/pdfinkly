"use client";

import { create } from "zustand";
import type { FontName, Operation } from "@pdfinkly/shared";

export type Tool =
  | "select" | "edittext" | "text" | "highlight" | "draw" | "rect" | "ellipse" | "arrow"
  | "image" | "note" | "signature" | "whiteout";

export type Mode = "edit" | "organize" | "sign";
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

export interface Style {
  color: string; // text & ink color
  stroke: string; // shape outline
  highlight: string;
  width: number;
  font: FontName;
  size: number;
}

interface EditorState {
  ops: Operation[];
  /** Ops before the cursor are applied; ops after it are the redo tail. */
  cursor: number;
  revision: number;
  saveState: SaveState;
  conflictServer: { operations: Operation[]; revision: number } | null;
  mode: Mode;
  tool: Tool;
  selected: string | null;
  editingText: string | null;
  pendingImage: { dataUrl: string; w: number; h: number } | null;
  style: Style;
  zoom: number;
  /** Bumped to ask the editor to open the OCR dialog. */
  ocrRequest: number;

  reset(ops: Operation[], revision: number): void;
  apply(...ops: Operation[]): void;
  undo(): void;
  redo(): void;
  setTool(t: Tool): void;
  setMode(m: Mode): void;
  select(id: string | null): void;
  setEditingText(id: string | null): void;
  setPendingImage(p: EditorState["pendingImage"]): void;
  setStyle(p: Partial<Style>): void;
  setZoom(z: number): void;
  requestOcr(): void;
  setSave(s: SaveState, extra?: Partial<Pick<EditorState, "revision" | "conflictServer">>): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  ops: [],
  cursor: 0,
  revision: 0,
  saveState: "idle",
  conflictServer: null,
  mode: "edit",
  tool: "select",
  selected: null,
  editingText: null,
  pendingImage: null,
  style: { color: "#18181B", stroke: "#DC2626", highlight: "#FACC15", width: 2, font: "Helvetica", size: 12 },
  zoom: 1,
  ocrRequest: 0,

  reset: (ops, revision) =>
    set({ ops, cursor: ops.length, revision, saveState: "idle", conflictServer: null, selected: null, editingText: null }),
  apply: (...newOps) => {
    const { ops, cursor } = get();
    const next = ops.slice(0, cursor).concat(newOps);
    set({ ops: next, cursor: next.length, saveState: "dirty" });
  },
  undo: () => {
    const { cursor } = get();
    if (cursor > 0) set({ cursor: cursor - 1, saveState: "dirty", selected: null, editingText: null });
  },
  redo: () => {
    const { cursor, ops } = get();
    if (cursor < ops.length) set({ cursor: cursor + 1, saveState: "dirty" });
  },
  setTool: (tool) => set({ tool, selected: null, editingText: null }),
  setMode: (mode) => set({ mode, tool: "select", selected: null, editingText: null }),
  select: (selected) => set({ selected }),
  setEditingText: (editingText) => set({ editingText }),
  setPendingImage: (pendingImage) => set({ pendingImage }),
  setStyle: (p) => set({ style: { ...get().style, ...p } }),
  setZoom: (zoom) => set({ zoom: Math.min(3, Math.max(0.4, Math.round(zoom * 100) / 100)) }),
  requestOcr: () => set((s) => ({ ocrRequest: s.ocrRequest + 1 })),
  setSave: (saveState, extra) => set({ saveState, ...extra }),
}));

export const effectiveOps = (s: Pick<EditorState, "ops" | "cursor">) => s.ops.slice(0, s.cursor);
