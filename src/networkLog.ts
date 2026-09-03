import type { NetworkEntry } from "./types.js";

// adb logcat's default (threadtime) format prefixes every single line with
// "MM-DD HH:MM:SS.mmm PID TID LEVEL TAG: " — including continuation lines
// of a multi-line app log statement. Every pattern below has to see past
// this or it matches nothing; stripping it once up front is simpler than
// working around it in each parser.
const LOGCAT_PREFIX = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]*:\s?/;

function stripLogcatPrefix(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(LOGCAT_PREFIX, ""))
    .join("\n");
}

const REQUEST_BLOCK = /\*\*\* Request \*\*\*([\s\S]*?)(?=\*\*\* (?:Response|DioException) \*\*\*|$)/g;
const RESPONSE_BLOCK = /\*\*\* Response \*\*\*([\s\S]*?)(?=\*\*\* (?:Request|DioException) \*\*\*|$)/g;

/** Finds "field: value" anywhere on a line, not anchored to line-start. */
function extractField(block: string, field: string): string | undefined {
  const re = new RegExp(`\\b${field}:\\s*(.+)`, "i");
  for (const line of block.split("\n")) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Dio's default LogInterceptor block format — the common case for a Flutter app. */
function parseDioStyle(text: string): NetworkEntry[] {
  const entries = new Map<string, NetworkEntry>();

  for (const m of text.matchAll(REQUEST_BLOCK)) {
    const url = extractField(m[1], "uri");
    if (!url) continue;
    entries.set(url, { url, method: extractField(m[1], "method") });
  }

  for (const m of text.matchAll(RESPONSE_BLOCK)) {
    const block = m[1];
    const url = extractField(block, "uri");
    if (!url) continue;
    const statusRaw = extractField(block, "statusCode");
    const statusCode = statusRaw !== undefined ? Number(statusRaw) : undefined;
    const bodyMatch = block.match(/Response Text:\s*\n?([\s\S]*)/i);
    const snippet = bodyMatch?.[1]?.trim().slice(0, 300) || undefined;
    const existing = entries.get(url) ?? { url };
    entries.set(url, {
      ...existing,
      statusCode: statusCode !== undefined && Number.isFinite(statusCode) ? statusCode : existing.statusCode,
      snippet,
    });
  }

  return [...entries.values()];
}

const OKHTTP_REQUEST_LINE = /-->\s+(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+)/;
const OKHTTP_RESPONSE_LINE = /<--\s+(\d{3})\s+(https?:\/\/\S+)/;

/** OkHttp's default logging interceptor: "--> METHOD url" then later "<-- STATUS url (time)". Paired by matching url, not proximity. */
function parseOkHttpStyle(text: string): NetworkEntry[] {
  const entries = new Map<string, NetworkEntry>();
  for (const line of text.split("\n")) {
    const reqMatch = line.match(OKHTTP_REQUEST_LINE);
    if (reqMatch) {
      const [, method, url] = reqMatch;
      entries.set(url, { ...(entries.get(url) ?? { url }), method, url });
      continue;
    }
    const resMatch = line.match(OKHTTP_RESPONSE_LINE);
    if (resMatch) {
      const [, status, url] = resMatch;
      entries.set(url, { ...(entries.get(url) ?? { url }), statusCode: Number(status), url });
    }
  }
  return [...entries.values()];
}

const GENERIC_REQUEST_LINE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+)/;
const GENERIC_STATUS_LINE = /\bstatus(?:Code)?[:\s]+(\d{3})\b/i;
const NEARBY_LINES = 5;

/**
 * Loosest fallback, for anything not recognized above: a "METHOD URL"
 * line, then a status code within a few lines after it. Proximity-based
 * pairing is inherently fuzzy — a short window keeps it from grabbing an
 * unrelated later request's status, but it's still a guess, not a parse.
 */
function parseGenericStyle(text: string): NetworkEntry[] {
  const lines = text.split("\n");
  const entries: NetworkEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const reqMatch = lines[i].match(GENERIC_REQUEST_LINE);
    if (!reqMatch) continue;
    const [, method, url] = reqMatch;

    let statusCode: number | undefined;
    for (let j = i; j < Math.min(i + NEARBY_LINES, lines.length); j++) {
      const statusMatch = lines[j].match(GENERIC_STATUS_LINE);
      if (statusMatch) {
        statusCode = Number(statusMatch[1]);
        break;
      }
    }
    entries.push({ method, url, statusCode });
  }

  return entries;
}

/**
 * Best-effort extraction of HTTP request/response info from a raw device
 * log (adb logcat). Tries Dio's default LogInterceptor block format, then
 * OkHttp's default logging interceptor format; falls back to a loose
 * "METHOD URL, status nearby" scan for anything else. Finding nothing
 * isn't an error — an app that doesn't log its network calls just won't
 * have any, and the raw log file (kept alongside) stays the ground truth
 * either way.
 */
export function parseNetworkLog(text: string): NetworkEntry[] {
  const cleaned = stripLogcatPrefix(text);

  const dioEntries = parseDioStyle(cleaned);
  if (dioEntries.length > 0) return dioEntries;

  const okHttpEntries = parseOkHttpStyle(cleaned);
  if (okHttpEntries.length > 0) return okHttpEntries;

  return parseGenericStyle(cleaned);
}
