import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export function apiUrl(endpoint: string): string {
  // Make sure the endpoint has a leading slash.
  return `${API_BASE}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;
}
