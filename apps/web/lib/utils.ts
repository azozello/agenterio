import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const AVATAR_HUES = [20, 60, 140, 190, 230, 270, 310, 350];

/** Stable per-person hue so the same author always gets the same avatar colour. */
export function avatarHue(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Time for today, otherwise a short date with time, e.g. "Oct 12, 14:05". */
export function formatWhen(iso: string) {
  const d = new Date(iso);
  if (new Date().toDateString() === d.toDateString()) return formatTime(iso);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${formatTime(iso)}`;
}

/** Time for today, otherwise just the short date. */
export function formatDay(iso: string) {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? formatTime(iso)
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
