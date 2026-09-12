import { toDataUri } from "../dataUri.js";
import type { NetworkEntry, RunSummary, TestCase, TestStatus } from "../types.js";

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]!);
}

function statusPillClass(status: TestStatus): string {
  if (status === "passed") return "ok";
  if (status === "skipped") return "skip";
  return "bad";
}

function fmtDuration(startedAt: string, finishedAt: string): string {
  const totalSeconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  return totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function renderNetworkLogs(entries: NetworkEntry[] | undefined): string {
  if (!entries || entries.length === 0) return "";
  const failedCount = entries.filter((e) => (e.statusCode !== undefined && e.statusCode >= 400) || (e.statusCode === undefined && e.snippet)).length;
  const label = `Network — ${entries.length} call${entries.length === 1 ? "" : "s"}${failedCount > 0 ? `, ${failedCount} failed` : ""}`;

  const rows = entries
    .map((e) => {
      const bad = (e.statusCode !== undefined && e.statusCode >= 400) || (e.statusCode === undefined && e.snippet);
      const statusClass = e.statusCode === undefined ? (e.snippet ? "bad" : "none") : bad ? "bad" : "ok";
      const statusLabel = e.statusCode === undefined ? (e.snippet ? "no response" : "—") : String(e.statusCode);
      return `
        <div class="net-row${bad ? " bad" : ""}">
          <div class="net-line">
            <span class="net-method">${escapeHtml(e.method ?? "?")}</span>
            <span class="net-url" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</span>
            <span class="net-status ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          ${e.snippet ? `<pre class="net-snippet">${escapeHtml(e.snippet)}</pre>` : ""}
        </div>`;
    })
    .join("");

  return `
    <details class="network">
      <summary class="network-summary"><svg class="arrow" width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>${label}</summary>
      <div class="network-entries">${rows}</div>
    </details>`;
}

function renderTestCase(test: TestCase): string {
  const screenshot = test.screenshotPath ? toDataUri(test.screenshotPath) : null;
  const bad = test.status === "failed" || test.status === "error";
  const filterKey = bad ? "failed" : test.status;

  const thumb = screenshot
    ? bad
      ? `<div><div class="thumb-lg" data-lightbox><img src="${screenshot}" alt=""></div><div class="thumb-caption">on-failure screenshot</div></div>`
      : `<div class="thumb" data-lightbox><img src="${screenshot}" alt=""></div>`
    : bad
      ? ""
      : "<span></span>";

  const body = bad
    ? `
      <div class="test-body">
        <div>
          ${test.message ? `<pre class="test-message">${escapeHtml(test.message)}</pre>` : ""}
          ${renderNetworkLogs(test.networkLogs)}
        </div>
        ${thumb}
      </div>`
    : test.status === "skipped" && test.message
      ? `<div class="test-body" style="grid-template-columns:1fr"><pre class="test-message test-message-neutral">${escapeHtml(test.message)}</pre></div>`
      : "";

  return `
    <div class="test-card status-${test.status}${bad ? " expanded" : ""}" data-filter="${filterKey}">
      <div class="test-row">
        <div class="test-name">${escapeHtml(test.name)}${test.classname ? `<span class="test-classname">${escapeHtml(test.classname)}</span>` : ""}</div>
        <span class="test-time">${test.timeSeconds !== undefined ? `${test.timeSeconds}s` : ""}</span>
        <span class="pill ${statusPillClass(test.status)}">${test.status}</span>
        ${!bad ? thumb : "<span></span>"}
      </div>
      ${body}
    </div>`;
}

export function renderHtmlReport(summary: RunSummary, dashboardUrl?: string | null): string {
  const allTests = summary.suites.flatMap((s) => s.tests);
  const failedCount = allTests.filter((t) => t.status === "failed" || t.status === "error").length;
  const passedCount = allTests.filter((t) => t.status === "passed").length;
  const skippedCount = allTests.filter((t) => t.status === "skipped").length;
  const duration = fmtDuration(summary.startedAt, summary.finishedAt);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kestrel test report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root {
    --bg: #eef1f4; --surface: #ffffff; --surface-2: #e4e9ee; --border: #d3dbe2;
    --text: #1a2027; --text-muted: #5c6a78; --text-faint: #8894a0;
    --accent: #c2570f; --accent-soft: #fbe4d2;
    --ok: #1f8f5f; --ok-soft: #e1f5ea; --bad: #c8402f; --bad-soft: #fbe6e2; --skip: #6b7684; --skip-soft: #e7ebee;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1318; --surface: #171d24; --surface-2: #1e262e; --border: #2a333c;
      --text: #e8edf1; --text-muted: #8fa0ad; --text-faint: #5f6c78;
      --accent: #e2812f; --accent-soft: #2e2013;
      --ok: #5fd39a; --ok-soft: #123024; --bad: #ef7a68; --bad-soft: #341714; --skip: #9aa7b2; --skip-soft: #1c232a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; }
  main { max-width: 920px; margin: 0 auto; padding: 32px 28px; }
  h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
  .dashboard-link { display: inline-block; margin: 0 0 20px; font-size: 13px; font-weight: 600; color: var(--accent); text-decoration: none; }
  .dashboard-link:hover { text-decoration: underline; }

  .stat-strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px; }
  .stat-tile { background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 12px 14px; border-left: 3px solid var(--border); }
  .stat-tile .n { font-size: 21px; font-weight: 700; display: block; font-variant-numeric: tabular-nums; }
  .stat-tile .l { font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-tile.ok { border-left-color: var(--ok); } .stat-tile.ok .n { color: var(--ok); }
  .stat-tile.bad { border-left-color: var(--bad); } .stat-tile.bad .n { color: var(--bad); }
  .stat-tile.skip { border-left-color: var(--skip); } .stat-tile.skip .n { color: var(--skip); }

  .filter-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .filter-btn { font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px; }
  .filter-btn:hover { border-color: var(--accent); }
  .filter-btn.active { background: var(--text); color: var(--surface); border-color: var(--text); }
  .filter-count { color: var(--text-faint); font-size: 12px; margin-left: auto; }

  .test-list { display: flex; flex-direction: column; gap: 8px; }
  .test-card { background: var(--surface); border: 1px solid var(--border); border-radius: 9px; border-left: 4px solid var(--border); overflow: hidden; }
  .test-card.status-failed, .test-card.status-error { border-left-color: var(--bad); }
  .test-card.status-passed { border-left-color: var(--ok); }
  .test-card.status-skipped { border-left-color: var(--skip); }
  .test-row { display: grid; grid-template-columns: 1fr auto auto auto; align-items: center; gap: 12px; padding: 10px 14px; }
  .test-card.expanded .test-row { padding-bottom: 8px; }
  .test-name { font-weight: 600; font-size: 13px; min-width: 0; }
  .test-classname { color: var(--text-faint); font-size: 11.5px; font-weight: 400; font-family: "IBM Plex Mono", monospace; display: block; margin-top: 1px; }
  .test-time { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .pill { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
  .pill.ok { background: var(--ok-soft); color: var(--ok); }
  .pill.bad { background: var(--bad-soft); color: var(--bad); }
  .pill.skip { background: var(--skip-soft); color: var(--skip); }

  .thumb { width: 30px; height: 52px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-2); flex: none; overflow: hidden; cursor: zoom-in; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .test-body { padding: 0 14px 14px; display: grid; grid-template-columns: 1fr 148px; gap: 16px; }
  .test-message { font-family: "IBM Plex Mono", monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; background: var(--bad-soft); color: var(--bad); border-radius: 6px; padding: 10px 12px; margin: 0 0 10px; }
  .test-message-neutral { background: var(--skip-soft); color: var(--text-muted); }
  .thumb-lg { border-radius: 7px; border: 1px solid var(--border); overflow: hidden; cursor: zoom-in; background: var(--surface-2); }
  .thumb-lg img { width: 100%; display: block; }
  .thumb-caption { font-size: 11px; color: var(--text-faint); text-align: center; margin-top: 5px; }

  .network { margin-top: 4px; }
  .network-summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font-size: 12px; font-weight: 600; color: var(--text-muted); padding: 4px 0; }
  .network-summary::-webkit-details-marker { display: none; }
  .network-summary .arrow { transition: transform .12s ease; }
  details[open] > .network-summary .arrow { transform: rotate(90deg); }
  .network-entries { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .net-row { border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; background: var(--surface-2); }
  .net-row.bad { border-color: var(--bad); }
  .net-line { display: flex; align-items: center; gap: 8px; }
  .net-method { font-family: "IBM Plex Mono", monospace; font-size: 10.5px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); flex: none; }
  .net-url { font-family: "IBM Plex Mono", monospace; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .net-status { font-family: "IBM Plex Mono", monospace; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; flex: none; }
  .net-status.ok { background: var(--ok-soft); color: var(--ok); }
  .net-status.bad { background: var(--bad-soft); color: var(--bad); }
  .net-status.none { background: var(--skip-soft); color: var(--skip); }
  .net-snippet { margin: 6px 0 0; font-family: "IBM Plex Mono", monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; background: var(--surface); border-radius: 5px; padding: 7px 9px; color: var(--text-muted); border: 1px solid var(--border); }

  .lightbox { position: fixed; inset: 0; background: rgba(10,12,15,0.7); display: none; align-items: center; justify-content: center; padding: 40px; cursor: zoom-out; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 10px; }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main>
  <h1>Kestrel test report</h1>
  <div class="sub">${new Date(summary.startedAt).toLocaleString()} &middot; ran ${duration}</div>
  ${dashboardUrl ? `<a class="dashboard-link" href="${dashboardUrl}" target="_blank" rel="noopener noreferrer">View on dashboard →</a>` : ""}

  <div class="stat-strip">
    <div class="stat-tile ok"><span class="n">${summary.passed}</span><span class="l">Passed</span></div>
    <div class="stat-tile bad"><span class="n">${summary.failed}</span><span class="l">Failed</span></div>
    <div class="stat-tile bad"><span class="n">${summary.errored}</span><span class="l">Errored</span></div>
    <div class="stat-tile skip"><span class="n">${summary.skipped}</span><span class="l">Skipped</span></div>
    <div class="stat-tile"><span class="n">${duration}</span><span class="l">Duration</span></div>
  </div>

  <div class="filter-bar">
    <button class="filter-btn active" data-filter="all">All <span>${allTests.length}</span></button>
    <button class="filter-btn" data-filter="failed">Failed <span>${failedCount}</span></button>
    <button class="filter-btn" data-filter="passed">Passed <span>${passedCount}</span></button>
    <button class="filter-btn" data-filter="skipped">Skipped <span>${skippedCount}</span></button>
    <span class="filter-count">${allTests.length} tests</span>
  </div>

  <div class="test-list" id="test-list">${allTests.map(renderTestCase).join("")}</div>
</main>
<div class="lightbox" id="lightbox"><img id="lightbox-img" alt=""></div>
<script>
  const list = document.getElementById('test-list');
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      list.querySelectorAll('.test-card').forEach((card) => {
        card.style.display = filter === 'all' || card.dataset.filter === filter ? '' : 'none';
      });
    });
  });
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  document.querySelectorAll('[data-lightbox]').forEach((el) => {
    el.addEventListener('click', () => {
      lightboxImg.src = el.querySelector('img').src;
      lightbox.classList.add('open');
    });
  });
  lightbox.addEventListener('click', () => lightbox.classList.remove('open'));
</script>
</body>
</html>
`;
}
