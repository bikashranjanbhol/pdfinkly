import type { ScanFilter } from "@pdfinkly/shared/scan";

export const FILTERS: { id: ScanFilter; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "White page, shadows removed, colour kept" },
  { id: "gray", label: "Greyscale", hint: "Clean grey tones" },
  { id: "bw", label: "Black & white", hint: "Crisp text, smallest file" },
  { id: "original", label: "Original", hint: "Just straightened" },
];
