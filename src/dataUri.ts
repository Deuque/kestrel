import { readFileSync } from "node:fs";
import { extname } from "node:path";

export function toDataUri(path: string): string | null {
  try {
    const buf = readFileSync(path);
    const ext = extname(path).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
