/* Stroke icons (24-unit grid). Decorative: always aria-hidden; label the button instead. */
type P = { size?: number; className?: string };
const base = (size: number) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
});
const make = (d: string) => function Icon({ size = 20, className }: P) {
  return <svg {...base(size)} className={className}><path d={d} /></svg>;
};

export const IconUpload = make("M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3");
export const IconDownload = make("M12 4v12M7 11l5 5 5-5M4 20h16");
export const IconFile = make("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5");
export const IconBack = make("M15 18l-6-6 6-6");
export const IconShare = make("M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13");
export const IconHistory = make("M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2");
export const IconUndo = make("M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3");
export const IconRedo = make("M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3");
export const IconSelect = make("M5 3l14 8-6 2-2 6z");
export const IconText = make("M5 6V4h14v2M12 4v16M9 20h6");
export const IconScan = make("M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 10h8M8 14h5");
export const IconEditText = make("M4 7V4h11v3M9.5 4v13M7 17h5M14.5 20.5l6.4-6.4a1.4 1.4 0 0 0-2-2L12.5 18.5 12 21z");
export const IconHighlight = make("M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4");
export const IconPen = make("M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z");
export const IconRect = make("M4 5h16v14H4z");
export const IconEllipse = make("M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z");
export const IconArrow = make("M5 19L19 5M19 5h-8M19 5v8");
export const IconImage = make("M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01");
export const IconNote = make("M5 4h14v11l-5 5H5zM14 20v-5h5");
export const IconSign = make("M3 17c3-3 5-9 7-9s-1 9 1 9 3-4 5-4 1 4 3 4h2M3 21h18");
export const IconEraser = make("M4 6h16v4H4zM4 14h10v4H4z");
export const IconRedact = make("M3 5h18v5H3zM3 14h7M14 14h7M3 19h11");
export const IconTrash = make("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3");
export const IconRotateL = make("M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5");
export const IconRotateR = make("M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5");
export const IconPlus = make("M12 5v14M5 12h14");
export const IconCheck = make("M5 12l5 5 9-10");
export const IconX = make("M6 6l12 12M18 6L6 18");
export const IconLock = make("M4 11h16v10H4zM8 11V7a4 4 0 0 1 8 0v4");
export const IconMore = make("M5 12h.01M12 12h.01M19 12h.01");
export const IconCopy = make("M9 9h11v11H9zM5 15V4h11");
export const IconPages = make("M3 3h7v9H3zM14 3h7v9h-7zM3 15h7v6H3zM14 15h7v6h-7z");
export const IconSearch = make("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5");
