/* What a file is, from its name.
 *
 * ⚠️ Not decoration. A page of Everything hits is a column of identical rows —
 * same shape, same grey, a name and a path — and the icon is the only part of a
 * row you read *without* reading it. Before this, finding the folder among six
 * files meant reading six paths.
 *
 * Pure, and tested, because the failure is soft: an unmapped extension still
 * gets the generic file glyph, so a wrong or missing entry never looks broken.
 * It just quietly stops helping.
 */
import type { TaskIcon } from "./task-icons";

/** ⚠️ Keyed WITHOUT the dot, lower case. The lookup lower-cases and strips. */
const KINDS: Record<string, TaskIcon> = {
  // Source, and the things that sit beside it.
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  rs: "code", py: "code", go: "code", java: "code", rb: "code", php: "code",
  c: "code", h: "code", cpp: "code", hpp: "code", cs: "code", swift: "code",
  kt: "code", liquid: "code", vue: "code", svelte: "code", sql: "code",
  html: "code", css: "code", scss: "code", json: "code", xml: "code",
  yml: "code", yaml: "code", toml: "code", lock: "code", sh: "code",

  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  svg: "image", avif: "image", bmp: "image", ico: "image", heic: "image",
  psd: "image", ai: "image", fig: "image",

  mp4: "video", mov: "video", mkv: "video", avi: "video", webm: "video",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", ogg: "audio",

  pdf: "pdf",
  zip: "zip", rar: "zip", "7z": "zip", tar: "zip", gz: "zip", xz: "zip",
  txt: "text", md: "text", log: "text", csv: "sheet",
  doc: "doc", docx: "doc", rtf: "doc", odt: "doc",
  xls: "sheet", xlsx: "sheet", ods: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides",

  // ⚠️ `lnk` is here because Everything returns shortcuts, and a shortcut to
  // Brave should not look like a text file.
  exe: "exe", msi: "exe", bat: "exe", cmd: "exe", ps1: "exe", lnk: "app",
};

/** The extension, lower case and without its dot, or "" if there is none.
 *
 *  ⚠️ A dotfile has no extension. `.gitignore` is a file called `.gitignore`,
 *  not a `gitignore` file, and treating the whole name as one would map half a
 *  repository's config to whatever `gitignore` happened to mean. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** The icon for a search hit. Folders are folders whatever they are called. */
export function iconFor(name: string, folder: boolean): TaskIcon {
  if (folder) return "folder";
  return KINDS[extensionOf(name)] ?? "file";
}
