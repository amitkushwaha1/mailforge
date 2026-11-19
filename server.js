const http = require("http");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;

const PORT = 3456;
const LOG_FILE = path.join(__dirname, "send-log.txt");
const STATE_FILE = path.join(__dirname, "state.json");
const VERSION = "3.0";

// ---------- state (daily counter) ----------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function today() { return new Date().toISOString().slice(0, 10); }
function sentToday() {
  const s = readState();
  return s.date === today() ? (s.count || 0) : 0;
}
function bumpToday(n) {
  const s = readState();
  const c = s.date === today() ? (s.count || 0) : 0;
  saveState({ date: today(), count: c + n });
}

// ---------- recipients / personalization ----------
function parseRecipients(text) {
  const parts = String(text || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const m =
      p.match(/^(.*)<\s*([^\s<>]+@[^\s<>]+)\s*>$/) ||
      p.match(/^"?([^"<]+)"?\s*<\s*([^\s<>]+@[^\s<>]+)\s*>$/) ||
      p.match(/^([^\s<>]+@[^\s<>]+)$/);
    if (!m) continue;
    const email = (m[2] || m[1]).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name: (m[1] || "").trim().replace(/^"|"$/g, ""), email });
  }
  return out;
}

function personalize(text, name, email) {
  const who = name || email.split("@")[0];
  return String(text || "")
    .replace(/\{\{\s*name\s*\}\}/gi, who)
    .replace(/\{\{\s*email\s*\}\}/gi, email);
}

function log(line) {
  const flat = String(line).replace(/\s*\n\s*/g, " ").trim();
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${flat}\n`);
}
function readLog() {
  try { return fs.readFileSync(LOG_FILE, "utf8"); } catch (e) { return ""; }
}
function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

// ---------- SPAM SHIELD: scoring ----------
const SPAM_WORDS = [
  ["act now", 1], ["buy now", 1], ["order now", 1], ["click here", 1],
  ["free!!!", 1.5], ["100% free", 1.5], ["free money", 1.5], ["free access", 1],
  ["guarantee", 1], ["guaranteed", 1], ["risk-free", 1], ["no obligation", 1],
  ["winner", 1], ["you have won", 1.5], ["congratulations", 1], ["prize", 0.5],
  ["limited time", 1], ["act fast", 1], ["hurry", 0.5], ["while supplies last", 1],
  ["cash bonus", 1], ["extra cash", 1], ["get paid", 1], ["earn extra", 1],
  ["million dollars", 1.5], ["double your", 1], ["income opportunity", 1],
  ["credit card", 0.5], ["billing address", 1], ["bank account", 0.5],
  ["passwords", 0.5], ["urgent", 0.5], ["immediate action", 1],
  ["special offer", 0.5], ["exclusive deal", 0.5], ["this is not spam", 1.5],
  ["trial", 0.5], ["viagra", 2], ["casino", 1], ["lottery", 1], ["crypto profit", 1.5],
  ["investment", 0.5], ["make money", 1], ["work from home", 0.5],
  ["once in a lifetime", 1], ["no catch", 1], ["satisfaction", 0.5],
  ["reminder", 0.2], ["final notice", 1], ["last chance", 0.5],
];
const LINK_SHORTENERS = ["bit.ly", "tinyurl.com", "t.co/", "goo.gl", "is.gd", "buff.ly", "ow.ly", "cutt.ly", "rb.gy"];

function spamScore(subject, body) {
  const sub = String(subject || "");
  const bod = String(body || "");
  const all = (sub + " " + bod).toLowerCase();
  const issues = [];
  let score = 0;
  const add = (pts, msg) => { score += pts; issues.push({ pts, msg }); };

  // spam words
  let hits = 0;
  const foundWords = [];
  for (const [w, p] of SPAM_WORDS) {
    if (all.includes(w)) { hits++; foundWords.push(w); score += p; }
  }
  if (hits) issues.push({ pts: +(score && foundWords.length ? SPAM_WORDS.filter(([w]) => all.includes(w)).reduce((a, [, p]) => a + p, 0) : 0).toFixed(1), msg: "Spam-trigger words: " + foundWords.slice(0, 8).join(", ") });

  // punctuation abuse
  if (/!{3,}/.test(sub + " " + bod)) add(1, "3+ exclamation marks (!!!) in message");
  if (/\?{3,}/.test(sub + " " + bod)) add(0.5, "3+ question marks (???) in message");
  if ((sub.match(/!/g) || []).length >= 2) add(0.5, "2+ '!' in subject");

  // caps
  if (sub && sub === sub.toUpperCase() && /[A-Z]{4,}/.test(sub)) add(1, "Subject is ALL CAPS");
  const capsWords = bod.match(/\b[A-Z]{4,}\b/g) || [];
  const wordCount = (bod.match(/\b\w+\b/g) || []).length || 1;
  if (capsWords.length >= 4) add(0.5, `Body has ${capsWords.length} ALL-CAPS words`);
  if (capsWords.length / wordCount > 0.15) add(0.5, "More than 15% of body is ALL-CAPS");

  // links
  const links = bod.match(/https?:\/\//gi) || [];
  if (links.length > 3) add(Math.min(2, (links.length - 3) * 0.5), `${links.length} links in body (max recommended: 3)`);
  const short = LINK_SHORTENERS.filter((s) => all.includes(s));
  if (short.length) add(1.5, `Link shortener used: ${short.join(", ")} — spam filters distrust these`);

  // money symbols
  const money = (bod.match(/[$€£₹]{2,}/g) || []).length;
  if (money) add(0.5, "Repeated money symbols ($$$)");

  // length & personalization
  if (bod.trim().length && bod.trim().length < 40) add(1, "Body is too short (< 40 chars)");
  else if (bod.trim().length && bod.trim().length < 100) add(0.4, "Body is quite short (< 100 chars)");
  if (!/\{\{\s*name\s*\}\}/i.test(sub + bod)) add(0.4, "No {{name}} personalization — bulk mails look identical without it");

  // emoji abuse
  const emojis = (bod.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  if (emojis > 5) add(0.5, `${emojis} emojis — looks promotional`);

  // subject tricks
  if (/^(re|fwd?):/i.test(sub.trim())) add(0.5, "Subject starts with RE:/FWD: but this is a new mail — looks deceptive");

  score = Math.round(Math.min(10, score) * 10) / 10;
  const grade = score <= 2 ? "A" : score <= 4 ? "B" : score <= 6 ? "C" : score <= 8 ? "D" : "F";
  const label = score <= 2 ? "Low risk" : score <= 4 ? "Moderate" : score <= 6 ? "High" : "Very high — likely spam";
  return { score, grade, label, issues };
}

// ---------- SPAM SHIELD: DNS deliverability ----------
async function checkSpf(domain) {
  try {
    const txts = await dns.resolveTxt(domain);
    const rec = txts.map((r) => r.join("")).find((t) => t.toLowerCase().startsWith("v=spf1"));
    if (!rec) return { ok: false, detail: "No SPF record found" };
    const ok = rec.includes("_spf.google.com") || rec.includes("include:");
    return { ok, detail: ok ? "SPF present (gmail relay allowed)" : "SPF exists but has no 'include:' — Gmail may fail SPF" };
  } catch (e) { return { ok: false, detail: "SPF lookup failed: " + e.code }; }
}
async function checkDkim(domain) {
  // Google's own consumer domains sign DKIM automatically — no public key to look up
  if (["gmail.com", "googlemail.com"].includes(domain.toLowerCase()))
    return { ok: true, detail: "Gmail signs DKIM automatically for @gmail.com senders" };
  // Other domains: Gmail signs with selector "google"
  try {
    const txts = await dns.resolveTxt(`google._domainkey.${domain}`);
    if (txts.length) return { ok: true, detail: "DKIM public key found (selector: google)" };
    return { ok: false, detail: "No DKIM key at google._domainkey" };
  } catch (e) {
    if (e.code === "ENODATA" || e.code === "ENOTFOUND")
      return { ok: false, detail: "No DKIM key found (selector: google)" };
    return { ok: false, detail: "DKIM lookup failed: " + e.code };
  }
}
async function checkDmarc(domain) {
  try {
    const txts = await dns.resolveTxt(`_dmarc.${domain}`);
    const rec = txts.map((r) => r.join("")).find((t) => t.toLowerCase().startsWith("v=dmarc1"));
    if (!rec) return { ok: false, detail: "No DMARC record found" };
    const policy = /p=(reject|quarantine)/i.exec(rec);
    return { ok: true, detail: "DMARC present" + (policy ? ` (policy: p=${policy[1].toLowerCase()})` : " (no policy set)") };
  } catch (e) {
    if (e.code === "ENODATA" || e.code === "ENOTFOUND") return { ok: false, detail: "No DMARC record found" };
    return { ok: false, detail: "DMARC lookup failed: " + e.code };
  }
}
async function checkMx(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) return { ok: true, detail: `${mx.length} MX record(s)` };
    return { ok: false, detail: "No MX records" };
  } catch (e) {
    if (e.code === "ENODATA" || e.code === "ENOTFOUND") return { ok: false, detail: "No MX records — mail will bounce" };
    return { ok: false, detail: "MX lookup failed: " + e.code };
  }
}

async function preflight(user, recipients, subject, body, opts = {}) {
  const report = { dns: null, mx: null, score: spamScore(subject, body), cap: null };
  const domain = String(user || "").split("@")[1] || "";
  if (domain && domain.includes(".")) {
    const [spf, dkim, dmarc] = await Promise.all([checkSpf(domain), checkDkim(domain), checkDmarc(domain)]);
    report.dns = { domain, spf, dkim, dmarc, ok: spf.ok && dkim.ok && dmarc.ok };
  }
  const domains = [...new Set(recipients.map((r) => r.email.split("@")[1]).filter(Boolean))];
  if (domains.length) {
    const results = await Promise.all(domains.map(async (d) => [d, await checkMx(d)]));
    report.mx = {
      checked: domains.length,
      valid: results.filter(([, r]) => r.ok).map(([d]) => d),
      invalid: results.filter(([, r]) => !r.ok).map(([d, r]) => ({ domain: d, detail: r.detail })),
    };
  }
  const cap = opts.dailyLimit || 500;
  const used = sentToday();
  report.cap = { used, limit: cap, remaining: Math.max(0, cap - used) };
  return report;
}

// ---------- HTML rendering (optional) ----------
function textToHtml(text) {
  const e = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return e(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/^/, "<p>").replace(/$/, "</p>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

// ---------- HTML shell ----------
function page({ title, body, script = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MailForge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#f4f6fb; --card:#ffffff; --ink:#17203a; --muted:#667085; --line:#e6e9f2;
    --brand:#5b5bd6; --brand-2:#7c6cf5; --brand-ink:#4a45c9;
    --ok:#0ea871; --ok-bg:#e7f8f1; --warn:#d97706; --warn-bg:#fff5e6;
    --err:#e5484d; --err-bg:#fdecec; --chip:#eef0ff;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body {
    font-family:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
    background:radial-gradient(900px 380px at 12% -8%, #e9e7ff 0%, transparent 60%),
               radial-gradient(800px 360px at 95% 4%, #dff3ff 0%, transparent 55%), var(--bg);
    color:var(--ink); min-height:100vh; -webkit-font-smoothing:antialiased;
  }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px;
    padding:16px 34px; background:rgba(255,255,255,.82); backdrop-filter:blur(10px);
    border-bottom:1px solid var(--line); position:sticky; top:0; z-index:20; }
  .brand { display:flex; align-items:center; gap:13px; }
  .logo { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; font-size:19px;
    background:linear-gradient(135deg,var(--brand),var(--brand-2)); box-shadow:0 8px 20px rgba(91,91,214,.32); }
  .brand .name { font-weight:800; font-size:18.5px; letter-spacing:-.3px; }
  .brand .tag { font-size:11.5px; color:var(--muted); font-weight:500; margin-top:1px; }
  nav { display:flex; gap:6px; }
  nav a { color:var(--muted); text-decoration:none; font-size:13.5px; font-weight:600;
    padding:9px 16px; border-radius:10px; border:1px solid transparent; transition:.15s; }
  nav a:hover { color:var(--brand-ink); background:var(--chip); }
  nav a.on { color:#fff; background:var(--brand); box-shadow:0 6px 16px rgba(91,91,214,.28); }
  main { max-width:940px; margin:34px auto; padding:0 22px 70px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px;
    padding:28px 30px; margin-bottom:22px;
    box-shadow:0 1px 2px rgba(23,32,58,.04), 0 12px 32px rgba(23,32,58,.06); }
  .card-head { display:flex; align-items:center; gap:12px; margin-bottom:4px; }
  .card-ic { width:36px; height:36px; border-radius:11px; display:grid; place-items:center;
    font-size:17px; background:var(--chip); border:1px solid #e2e4ff; flex:none; }
  .card h2 { margin:0; font-size:16.5px; font-weight:700; letter-spacing:-.2px; }
  .sub { color:var(--muted); font-size:13.5px; line-height:1.6; margin:6px 0 20px 48px; }
  .sub code, .hint code { background:var(--chip); color:var(--brand-ink); padding:2px 7px;
    border-radius:6px; font-size:12.5px; font-family:Consolas,monospace; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; }
  @media (max-width:720px){ .grid2,.grid3 { grid-template-columns:1fr; } .sub { margin-left:0; } }
  label { display:block; font-size:12.5px; color:#475467; margin:0 0 7px; font-weight:600; letter-spacing:.15px; }
  input[type=text], input[type=email], input[type=password], input[type=number], select, textarea {
    width:100%; padding:12px 14px; background:#fbfcff; color:var(--ink);
    border:1.5px solid var(--line); border-radius:11px; font-size:14.5px; outline:none;
    transition:border-color .15s, box-shadow .15s; font-family:inherit; }
  input::placeholder, textarea::placeholder { color:#98a2b3; }
  textarea { resize:vertical; font-family:Consolas,"Courier New",monospace; font-size:13.5px; line-height:1.65; }
  input:focus, textarea:focus, select:focus { border-color:var(--brand); box-shadow:0 0 0 4px rgba(91,91,214,.13); background:#fff; }
  .hint { font-size:12.5px; color:var(--muted); margin-top:8px; line-height:1.55; }
  .count { font-weight:700; color:var(--brand-ink); }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .chip { background:var(--chip); border:1.5px solid #e2e4ff; color:var(--brand-ink);
    border-radius:999px; padding:6px 14px; font-size:12.5px; font-weight:600;
    cursor:pointer; font-family:inherit; transition:.15s; }
  .chip:hover { background:var(--brand); color:#fff; border-color:var(--brand); }
  .switch { display:flex; align-items:flex-start; gap:11px; font-size:14px;
    background:#fbfcff; border:1.5px solid var(--line); border-radius:12px; padding:14px 16px; cursor:pointer; }
  .switch input { width:17px; height:17px; margin-top:1px; accent-color:var(--brand); flex:none; }
  .switch .t { font-weight:600; }
  .switch .d { color:var(--muted); font-size:12.5px; margin-top:3px; line-height:1.5; }
  #spambox { display:none; margin-top:16px; padding:15px 18px; border-radius:12px;
    background:var(--warn-bg); border:1.5px solid #f5d9a6; font-size:13.5px; color:#92400e; line-height:1.6; }
  #spambox b { color:#b45309; }
  .actions { display:flex; gap:14px; margin-top:6px; align-items:center; flex-wrap:wrap; }
  .btn { border:0; padding:14px 28px; border-radius:12px; font-size:15px; font-weight:700;
    cursor:pointer; font-family:inherit; letter-spacing:.1px; transition:transform .1s, box-shadow .15s, opacity .15s; }
  .btn.primary { color:#fff; background:linear-gradient(135deg,var(--brand),var(--brand-2));
    box-shadow:0 8px 22px rgba(91,91,214,.32); }
  .btn.primary:hover { transform:translateY(-1px); box-shadow:0 12px 26px rgba(91,91,214,.4); }
  .btn.primary:disabled { opacity:.6; cursor:wait; transform:none; box-shadow:none; }
  .btn.ghost { background:#fff; color:#475467; border:1.5px solid var(--line); padding:13px 22px; }
  .btn.ghost:hover { border-color:var(--brand); color:var(--brand-ink); }
  .btn.ghost:disabled { opacity:.6; cursor:wait; }
  .btn.shield { background:linear-gradient(135deg,#0ea871,#12b886); color:#fff;
    box-shadow:0 8px 22px rgba(14,168,113,.28); }
  .btn.shield:hover { transform:translateY(-1px); }
  .btn.shield:disabled { opacity:.6; cursor:wait; transform:none; }
  #status { display:none; margin-top:18px; padding:16px 18px; border-radius:12px; font-size:14px;
    background:#fbfcff; border:1.5px solid var(--line); white-space:pre-wrap; line-height:1.65; }
  #status.ok { background:var(--ok-bg); border-color:#b5e8d4; color:#067a51; }
  #status.err { background:var(--err-bg); border-color:#f6c6c8; color:#b3261e; }
  #status.info { background:var(--chip); border-color:#dcdcff; color:var(--brand-ink); }
  .progress { height:9px; background:var(--line); border-radius:99px; overflow:hidden; margin-top:16px; display:none; }
  .progress i { display:block; height:100%; width:0%; background:linear-gradient(90deg,var(--brand),var(--ok)); transition:width .3s; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(165px,1fr)); gap:16px; }
  .stat { background:linear-gradient(180deg,#fbfcff,#f6f7fd); border:1.5px solid var(--line); border-radius:14px; padding:20px; }
  .stat .n { font-size:30px; font-weight:800; letter-spacing:-1px; }
  .stat .l { font-size:11.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; font-weight:700; margin-top:5px; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:12px 14px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.8px; font-weight:700; background:#fbfcff; }
  tr:last-child td { border-bottom:0; }
  tbody tr:hover { background:#fbfcff; }
  .badge { display:inline-block; padding:4px 11px; border-radius:99px; font-size:11.5px; font-weight:700; }
  .badge.ok { background:var(--ok-bg); color:var(--ok); }
  .badge.err { background:var(--err-bg); color:var(--err); }
  .badge.warn { background:var(--warn-bg); color:var(--warn); }
  .badge.info { background:var(--chip); color:var(--brand-ink); }
  .tips { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
  .tips li { display:flex; gap:12px; align-items:flex-start; font-size:13.5px; color:var(--muted);
    line-height:1.6; background:#fbfcff; border:1.5px solid var(--line); border-radius:12px; padding:13px 16px; }
  .tips .ic { flex:none; width:22px; height:22px; border-radius:7px; display:grid; place-items:center;
    font-size:12px; background:var(--chip); }
  .tips b { color:var(--ink); }
  footer { text-align:center; color:var(--muted); font-size:12.5px; padding:26px; border-top:1px solid var(--line); background:#fff; }
  a.link { color:var(--brand-ink); font-weight:600; text-decoration:none; }
  a.link:hover { text-decoration:underline; }
  .empty { text-align:center; padding:34px 10px; color:var(--muted); font-size:14px; }

  /* Spam Shield */
  .meter { display:flex; align-items:center; gap:16px; background:linear-gradient(180deg,#fbfcff,#f6f7fd);
    border:1.5px solid var(--line); border-radius:14px; padding:18px 20px; }
  .gauge { position:relative; width:92px; height:92px; flex:none; }
  .gauge svg { transform:rotate(-90deg); }
  .gauge .val { position:absolute; inset:0; display:grid; place-items:center;
    font-size:26px; font-weight:800; letter-spacing:-1px; }
  .meter .meta .lbl { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; font-weight:700; }
  .meter .meta .grade { font-size:19px; font-weight:800; margin-top:3px; }
  .meter .meta .desc { font-size:13px; color:var(--muted); margin-top:4px; line-height:1.5; }
  .issue-list { list-style:none; margin:14px 0 0; padding:0; display:grid; gap:8px; }
  .issue-list li { display:flex; gap:10px; align-items:flex-start; font-size:13px; line-height:1.55;
    background:#fbfcff; border:1.5px solid var(--line); border-radius:10px; padding:10px 13px; color:#475467; }
  .issue-list .pts { flex:none; font-weight:800; color:var(--warn); font-size:12.5px;
    background:var(--warn-bg); border-radius:7px; padding:2px 8px; }
  .dns-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; margin-top:14px; }
  .dns-item { background:#fbfcff; border:1.5px solid var(--line); border-radius:12px; padding:14px 16px; }
  .dns-item .h { display:flex; align-items:center; justify-content:space-between; gap:8px;
    font-weight:700; font-size:13.5px; }
  .dns-item .d { font-size:12.5px; color:var(--muted); margin-top:6px; line-height:1.5; }
  .fix { margin-top:8px; font-size:12.5px; background:var(--chip); border:1.5px solid #dcdcff;
    color:var(--brand-ink); border-radius:9px; padding:9px 12px; line-height:1.55; }
  .shield-result { display:none; margin-top:18px; }
  .opt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-top:4px; }
  .opt { background:#fbfcff; border:1.5px solid var(--line); border-radius:12px; padding:13px 15px; }
  .opt label { margin:0 0 7px; }
  .opt .hint { margin-top:6px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="logo">✉️</div>
    <div>
      <div class="name">MailForge</div>
      <div class="tag">Professional Bulk Mailer · v${VERSION}</div>
    </div>
  </div>
  <nav>
    <a href="/" class="${title === "Dashboard" ? "on" : ""}">Dashboard</a>
    <a href="/log" class="${title === "Send Log" ? "on" : ""}">Reports &amp; Log</a>
  </nav>
</header>
<main>${body}</main>
<footer>MailForge · Runs 100% on your machine (localhost) · Gmail SMTP via App Password</footer>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

// ---------- dashboard ----------
function dashboardPage() {
  const used = sentToday();
  const body = `
  <div class="card">
    <div class="card-head"><div class="card-ic">🔑</div><h2>Sender Account</h2></div>
    <div class="sub">Gmail address + 16-digit App Password. Create one at <code>Google Account → Security → 2-Step Verification → App passwords</code>.</div>
    <div class="grid2">
      <div>
        <label for="user">Gmail Address</label>
        <input type="email" id="user" placeholder="you@gmail.com" autocomplete="off">
      </div>
      <div>
        <label for="pass">App Password</label>
        <input type="password" id="pass" placeholder="•••• •••• •••• ••••" autocomplete="off">
      </div>
    </div>
    <div class="hint">🔒 Your password is never stored — it is used only for SMTP authentication.</div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-ic">👥</div><h2>Recipients</h2></div>
    <div class="sub">One email per line. Both <code>email@example.com</code> and <code>Name &lt;email@example.com&gt;</code> formats work. Duplicates and invalid addresses are skipped automatically. MX check (Spam Shield) will flag dead domains before sending.</div>
    <label for="recipients">Email List</label>
    <textarea id="recipients" rows="6" placeholder="ramesh@example.com&#10;Suresh Kumar &lt;suresh@example.com&gt;&#10;priya@example.com"></textarea>
    <div class="hint"><span class="count" id="rcount">0</span> valid recipients detected · <span id="rdup"></span></div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-ic">📝</div><h2>Message</h2></div>
    <div class="sub">Personalize each mail with <code>{{name}}</code> or <code>{{email}}</code> — unique mails perform much better with spam filters.</div>
    <label for="subject">Subject Line</label>
    <input type="text" id="subject" placeholder="Write your subject here">
    <div style="height:16px"></div>
    <label for="body">Body</label>
    <textarea id="body" rows="9" placeholder="Hello {{name}},&#10;&#10;Write your message here...&#10;&#10;Best regards,&#10;Your Name"></textarea>
    <div class="hint">Insert:</div>
    <div class="chips">
      <button class="chip" data-ins="{{name}}">{{name}}</button>
      <button class="chip" data-ins="{{email}}">{{email}}</button>
      <button class="chip" data-ins="&#10;&#10;">Paragraph break</button>
    </div>
    <label class="switch" for="footer" style="margin-top:16px">
      <input type="checkbox" id="footer" checked>
      <span>
        <span class="t">Add unsubscribe footer + List-Unsubscribe header</span>
        <span class="d">Recommended — tells spam filters you are a legitimate sender, and lets recipients opt out.</span>
      </span>
    </label>
  </div>

  <div class="card" style="border-color:#b5e8d4">
    <div class="card-head"><div class="card-ic" style="background:var(--ok-bg);border-color:#b5e8d4">🛡️</div>
      <h2>Spam Shield</h2><span class="badge ok" style="margin-left:auto">LIVE</span></div>
    <div class="sub">Live spam scoring + DNS deliverability checks (SPF / DKIM / DMARC) + recipient MX validation. Run it before every bulk send.</div>

    <div class="grid2" style="align-items:start">
      <div class="meter">
        <div class="gauge">
          <svg width="92" height="92" viewBox="0 0 92 92">
            <circle cx="46" cy="46" r="38" fill="none" stroke="#e6e9f2" stroke-width="10"/>
            <circle id="gaugeArc" cx="46" cy="46" r="38" fill="none" stroke="#0ea871" stroke-width="10"
              stroke-linecap="round" stroke-dasharray="238.8" stroke-dashoffset="238.8"/>
          </svg>
          <div class="val" id="gaugeVal" style="color:var(--ok)">0</div>
        </div>
        <div class="meta">
          <div class="lbl">Spam Risk Score</div>
          <div class="grade" id="gradeTxt" style="color:var(--ok)">Grade A · Low risk</div>
          <div class="desc" id="gradeDesc">No spam triggers detected. Keep it clean!</div>
        </div>
      </div>
      <div>
        <div class="opt">
          <label style="margin-bottom:6px">Daily send cap</label>
          <input type="number" id="dailyLimit" value="100" min="1" max="500">
          <div class="hint">Gmail hard limit is ~500/day. Today: <b id="usedToday">${used}</b> sent.</div>
        </div>
      </div>
    </div>

    <ul class="issue-list" id="issueList"></ul>

    <div class="actions" style="margin-top:20px">
      <button class="btn shield" id="pfBtn">🛡️ &nbsp;Run Pre-flight Check (DNS + MX + Score)</button>
    </div>

    <div class="shield-result" id="pfResult">
      <div style="margin-top:18px;font-weight:700;font-size:14px">Sender authentication (your domain)</div>
      <div class="dns-grid" id="dnsGrid"></div>
      <div style="margin-top:16px;font-weight:700;font-size:14px">Recipient domains (MX)</div>
      <div class="dns-grid" id="mxGrid"></div>
      <div style="margin-top:16px;font-weight:700;font-size:14px">Daily quota</div>
      <div class="dns-grid" id="capGrid"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-ic">⚙️</div><h2>Send Options</h2></div>
    <div class="sub">Tune delivery behaviour. Safer defaults are pre-selected.</div>
    <div class="opt-grid">
      <div class="opt">
        <label for="delay">Delay between mails</label>
        <select id="delay">
          <option value="1500" selected>1.5 s (recommended)</option>
          <option value="1000">1 s (faster)</option>
          <option value="2500">2.5 s (safer)</option>
          <option value="4000">4 s (warm-up / new account)</option>
        </select>
      </div>
      <div class="opt">
        <label for="format">Mail format</label>
        <select id="format">
          <option value="text" selected>Plain text (safest)</option>
          <option value="html">HTML (bold/links)</option>
        </select>
        <div class="hint">HTML mails use <b>text + html</b> multipart — best practice.</div>
      </div>
      <div class="opt">
        <label for="warmup">Warm-up batch limit</label>
        <select id="warmup">
          <option value="0" selected>Off (full list)</option>
          <option value="20">First 20 mails only</option>
          <option value="50">First 50 mails only</option>
        </select>
        <div class="hint">New accounts should warm up slowly.</div>
      </div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <label class="switch" for="blockHigh">
        <input type="checkbox" id="blockHigh" checked>
        <span><span class="t">Block send if spam score is high (&gt; 6)</span>
        <span class="d">Tool refuses to send risky content until you fix it.</span></span>
      </label>
      <label class="switch" for="requireMx">
        <input type="checkbox" id="requireMx" checked>
        <span><span class="t">Skip recipients with dead domains</span>
        <span class="d">MX check removes bouncing addresses — protects reputation.</span></span>
      </label>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-ic">🚀</div><h2>Delivery</h2></div>
    <div class="sub">Authenticated SMTP with TLS 1.2+ · unique Message-ID per mail · rate-limited.</div>
    <div class="actions">
      <button class="btn primary" id="btn">🚀 &nbsp;Send Mails</button>
      <button class="btn ghost" id="testBtn">Send 1 test to myself</button>
    </div>
    <div class="progress" id="prog"><i id="progBar"></i></div>
    <div id="status"></div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-ic">✅</div><h2>Inbox Placement Checklist</h2></div>
    <div class="sub">How to keep your mails out of the spam folder.</div>
    <ul class="tips">
      <li><span class="ic">🔐</span><span><b>SPF / DKIM / DMARC:</b> Run the Pre-flight Check — it reads your domain's real DNS records and tells you exactly what is missing.</span></li>
      <li><span class="ic">⭐</span><span><b>Sender reputation:</b> On a new account, use the 4 s delay + 20-mail warm-up first, then run the full list.</span></li>
      <li><span class="ic">🧹</span><span><b>Content hygiene:</b> Spam Shield scores your subject/body live — keep the grade at A or B before sending.</span></li>
      <li><span class="ic">🎯</span><span><b>Personalization:</b> <code>{{name}}</code> makes every mail unique, so bulk duplicate-content filters don't flag you.</span></li>
      <li><span class="ic">🚪</span><span><b>Unsubscribe:</b> Keep the footer on — recipients who can't opt out mark you as spam, which directly damages your reputation.</span></li>
      <li><span class="ic">📦</span><span><b>Volume:</b> Respect the daily cap. Remove bounced addresses (MX check flags them) from your next list.</span></li>
      <li><span class="ic">🏢</span><span><b>Need more?</b> Gmail's 500/day cap is a hard limit for bulk marketing — use a service like SendGrid or Mailgun for larger volumes.</span></li>
    </ul>
  </div>`;

  const script = `
    const $ = (id) => document.getElementById(id);
    const rcEl = $("recipients");

    // ---- client-side spam scorer (mirrors server) ----
    const SPAM_WORDS = [["act now",1],["buy now",1],["order now",1],["click here",1],["free!!!",1.5],
      ["100% free",1.5],["free money",1.5],["free access",1],["guarantee",1],["guaranteed",1],
      ["risk-free",1],["no obligation",1],["winner",1],["you have won",1.5],["congratulations",1],
      ["prize",.5],["limited time",1],["act fast",1],["hurry",.5],["while supplies last",1],
      ["cash bonus",1],["extra cash",1],["get paid",1],["earn extra",1],["million dollars",1.5],
      ["double your",1],["income opportunity",1],["credit card",.5],["billing address",1],
      ["bank account",.5],["passwords",.5],["urgent",.5],["immediate action",1],["special offer",.5],
      ["exclusive deal",.5],["this is not spam",1.5],["trial",.5],["viagra",2],["casino",1],
      ["lottery",1],["crypto profit",1.5],["investment",.5],["make money",1],["work from home",.5],
      ["once in a lifetime",1],["no catch",1],["satisfaction",.5],["reminder",.2],
      ["final notice",1],["last chance",.5]];
    const SHORTENERS = ["bit.ly","tinyurl.com","t.co/","goo.gl","is.gd","buff.ly","ow.ly","cutt.ly","rb.gy"];

    function score(sub, bod) {
      const all = (sub + " " + bod).toLowerCase();
      const issues = []; let s = 0;
      const add = (p, m) => { s += p; issues.push({ pts: p, msg: m }); };
      const found = SPAM_WORDS.filter(([w]) => all.includes(w));
      if (found.length) {
        const pts = found.reduce((a, [, p]) => a + p, 0);
        s += pts;
        issues.push({ pts: Math.round(pts * 10) / 10, msg: "Spam-trigger words: " + found.map(([w]) => w).slice(0, 8).join(", ") });
      }
      if (/!{3,}/.test(sub + " " + bod)) add(1, "3+ exclamation marks (!!!) in message");
      if (/\\?{3,}/.test(sub + " " + bod)) add(.5, "3+ question marks (???) in message");
      if ((sub.match(/!/g) || []).length >= 2) add(.5, "2+ '!' in subject");
      if (sub && sub === sub.toUpperCase() && /[A-Z]{4,}/.test(sub)) add(1, "Subject is ALL CAPS");
      const caps = bod.match(/\\b[A-Z]{4,}\\b/g) || [];
      const wc = (bod.match(/\\b\\w+\\b/g) || []).length || 1;
      if (caps.length >= 4) add(.5, "Body has " + caps.length + " ALL-CAPS words");
      if (caps.length / wc > .15) add(.5, "More than 15% of body is ALL-CAPS");
      const links = bod.match(/https?:\\/\\//gi) || [];
      if (links.length > 3) add(Math.min(2, (links.length - 3) * .5), links.length + " links in body (max recommended: 3)");
      const short = SHORTENERS.filter((x) => all.includes(x));
      if (short.length) add(1.5, "Link shortener used: " + short.join(", ") + " — spam filters distrust these");
      if ((bod.match(/[$€£₹]{2,}/g) || []).length) add(.5, "Repeated money symbols ($$$)");
      if (bod.trim().length && bod.trim().length < 40) add(1, "Body is too short (< 40 chars)");
      else if (bod.trim().length && bod.trim().length < 100) add(.4, "Body is quite short (< 100 chars)");
      if (!/\\{\\{\\s*name\\s*\\}\\}/i.test(sub + bod)) add(.4, "No {{name}} personalization — bulk mails look identical without it");
      const em = (bod.match(/[\\u{1F300}-\\u{1FAFF}]/gu) || []).length;
      if (em > 5) add(.5, em + " emojis — looks promotional");
      if (/^(re|fwd?):/i.test(sub.trim())) add(.5, "Subject starts with RE:/FWD: but this is a new mail — looks deceptive");
      s = Math.round(Math.min(10, s) * 10) / 10;
      const grade = s <= 2 ? "A" : s <= 4 ? "B" : s <= 6 ? "C" : s <= 8 ? "D" : "F";
      const label = s <= 2 ? "Low risk" : s <= 4 ? "Moderate" : s <= 6 ? "High" : "Very high — likely spam";
      const color = s <= 2 ? "#0ea871" : s <= 4 ? "#d97706" : s <= 6 ? "#e8590c" : "#e5484d";
      return { score: s, grade, label, color, issues };
    }

    function renderGauge() {
      const r = score($("subject").value, $("body").value);
      const C = 238.8;
      $("gaugeArc").setAttribute("stroke-dashoffset", C - (C * r.score / 10));
      $("gaugeArc").setAttribute("stroke", r.color);
      $("gaugeVal").textContent = r.score;
      $("gaugeVal").style.color = r.color;
      $("gradeTxt").textContent = "Grade " + r.grade + " · " + r.label;
      $("gradeTxt").style.color = r.color;
      $("gradeDesc").textContent = r.issues.length
        ? r.issues.length + " issue(s) found — fix them for best inbox placement."
        : "No spam triggers detected. Keep it clean!";
      $("issueList").innerHTML = r.issues.map((i) =>
        "<li><span class='pts'>+" + i.pts + "</span><span>" + i.msg.replace(/</g, "&lt;") + "</span></li>").join("");
      return r;
    }

    function refreshCount() {
      const raw = rcEl.value.split(/[\\n,;]+/).map((s) => s.trim()).filter(Boolean);
      const emails = new Set(); let bad = 0;
      for (const p of raw) {
        const m = p.match(/^(.*)<\\s*([^\\s<>]+@[^\\s<>]+)\\s*>$/) || p.match(/^([\\s\\S]+@[\\s\\S]+)$/);
        if (!m) { bad++; continue; }
        const e = (m[2] || m[1]).toLowerCase();
        if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(e)) { bad++; continue; }
        emails.add(e);
      }
      $("rcount").textContent = emails.size;
      $("rdup").textContent = bad ? (bad + " invalid skipped") : "no duplicates";
    }
    rcEl.addEventListener("input", refreshCount);

    document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
      const t = $("body"); const ins = c.dataset.ins;
      const p = t.selectionStart;
      t.value = t.value.slice(0, p) + ins + t.value.slice(t.selectionEnd);
      t.focus(); t.selectionStart = t.selectionEnd = p + ins.length;
      renderGauge();
    }));

    $("subject").addEventListener("input", renderGauge);
    $("body").addEventListener("input", renderGauge);
    renderGauge(); refreshCount();

    function show(cls, msg) { const s = $("status"); s.style.display = "block"; s.className = cls; s.textContent = msg; }
    async function post(url, payload) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return r.json();
    }
    function collect() {
      return {
        user: $("user").value, pass: $("pass").value, recipients: rcEl.value,
        subject: $("subject").value, body: $("body").value, footer: $("footer").checked,
        options: {
          delay: parseInt($("delay").value, 10),
          format: $("format").value,
          warmup: parseInt($("warmup").value, 10),
          dailyLimit: parseInt($("dailyLimit").value, 10) || 100,
          blockHigh: $("blockHigh").checked,
          requireMx: $("requireMx").checked,
        },
      };
    }

    // ---- pre-flight ----
    $("pfBtn").addEventListener("click", async () => {
      const d = collect();
      if (!d.user) return show("err", "Enter your Gmail address first (needed for DNS checks).");
      const btn = $("pfBtn"); btn.disabled = true; btn.textContent = "Running checks…";
      show("info", "Checking DNS records, recipient MX and spam score…");
      try {
        const j = await post("/preflight", d);
        if (!j.ok) { show("err", j.message); btn.disabled = false; btn.innerHTML = "🛡️ &nbsp;Run Pre-flight Check (DNS + MX + Score)"; return; }
        const r = j.report;
        const row = (name, o, fix) =>
          '<div class="dns-item"><div class="h"><span>' + name + '</span><span class="badge ' +
          (o.ok ? 'ok">✓ PASS' : 'err">✗ FAIL') + '</span></div><div class="d">' + o.detail + '</div>' +
          (o.ok ? "" : '<div class="fix"><b>How to fix:</b> ' + fix + "</div>") + "</div>";
        $("dnsGrid").innerHTML = r.dns
          ? row("SPF", r.dns.spf, "Add a TXT record on " + r.dns.domain + ': <code>v=spf1 include:_spf.google.com ~all</code>')
            + row("DKIM", r.dns.dkim, /gmail\.com$/i.test(r.dns.domain) ? "Gmail signs DKIM automatically for @gmail.com — nothing to fix." : "In Google Admin → Apps → Gmail → Authenticate email, generate a DKIM key (selector: google), then publish the TXT record.")
            + row("DMARC", r.dns.dmarc, 'Add TXT record on _dmarc.' + r.dns.domain + ': <code>v=DMARC1; p=quarantine; rua=mailto:' + d.user + '</code>')
          : '<div class="dns-item"><div class="d">Enter a valid sender address to run DNS checks.</div></div>';
        $("mxGrid").innerHTML = r.mx
          ? (r.mx.valid.length ? '<div class="dns-item"><div class="h"><span>' + r.mx.valid.join(", ") + '</span><span class="badge ok">✓ MX OK</span></div><div class="d">Mail servers found — deliverable.</div></div>' : "")
            + r.mx.invalid.map((x) => '<div class="dns-item"><div class="h"><span>' + x.domain + '</span><span class="badge err">✗ DEAD</span></div><div class="d">' + x.detail + '</div><div class="fix">Remove these addresses from your list — they only create bounces.</div></div>').join("")
          : '<div class="dns-item"><div class="d">Add recipients to check their domains.</div></div>';
        $("capGrid").innerHTML = '<div class="dns-item"><div class="h"><span>Today\\'s quota</span><span class="badge ' +
          (r.cap.remaining > 0 ? 'info">' + r.cap.used + " / " + r.cap.limit : 'warn">LIMIT REACHED') +
          '</span></div><div class="d">' + r.cap.remaining + " mails remaining today (resets at midnight).</div></div>";
        $("pfResult").style.display = "block";
        const s = r.score;
        let msg = "PRE-FLIGHT REPORT\\n\\nSpam score: " + s.score + " / 10 (Grade " + s.grade + " — " + s.label + ")";
        if (s.issues.length) msg += "\\nIssues:\\n" + s.issues.map((i) => "- [" + i.pts + "] " + i.msg).join("\\n");
        if (r.dns) msg += "\\n\\nDNS: SPF " + (r.dns.spf.ok ? "✓" : "✗") + " · DKIM " + (r.dns.dkim.ok ? "✓" : "✗") + " · DMARC " + (r.dns.dmarc.ok ? "✓" : "✗");
        if (r.mx) msg += "\\nMX: " + r.mx.valid.length + " ok, " + r.mx.invalid.length + " dead domain(s)";
        msg += "\\nQuota: " + r.cap.used + "/" + r.cap.limit + " used today";
        msg += "\\n\\n" + (s.score > 6 ? "⚠ Fix the warnings before sending." : "✅ Safe to send.");
        show(s.score > 6 ? "err" : "ok", msg);
      } catch (e) { show("err", "Error: " + e.message); }
      btn.disabled = false; btn.innerHTML = "🛡️ &nbsp;Run Pre-flight Check (DNS + MX + Score)";
    });

    // ---- send ----
    $("btn").addEventListener("click", async () => {
      const payload = collect();
      const btn = $("btn"); btn.disabled = true; btn.textContent = "Sending…";
      $("prog").style.display = "block"; $("progBar").style.width = "30%";
      show("info", "Sending… (rate-limited)");
      try {
        const j = await post("/send", payload);
        $("progBar").style.width = "100%";
        show(j.ok ? "ok" : "err", j.message);
        if (j.sent) $("usedToday").textContent = j.usedToday;
      } catch (e) { show("err", "Error: " + e.message); }
      btn.disabled = false; btn.innerHTML = "🚀 &nbsp;Send Mails";
    });

    $("testBtn").addEventListener("click", async () => {
      const payload = collect();
      if (!payload.user) return show("err", "Enter your Gmail address first.");
      payload.recipients = payload.user;
      payload.subject = "MailForge test mail for {{name}}";
      payload.body = "Hello {{name}},\\n\\nThis is a test mail from MailForge. If it arrived in your inbox, everything is working correctly.\\n\\nBest regards,\\nMailForge";
      payload.footer = false;
      payload.options.warmup = 0;
      const btn = $("testBtn"); btn.disabled = true; btn.textContent = "Sending test…";
      show("info", "Sending a test mail to " + payload.user + " …");
      try { const j = await post("/send", payload); show(j.ok ? "ok" : "err", j.message); }
      catch (e) { show("err", "Error: " + e.message); }
      btn.disabled = false; btn.textContent = "Send 1 test to myself";
    });
  `;
  return page({ title: "Dashboard", body, script });
}

// ---------- log / report ----------
function logPage() {
  const raw = readLog();
  const lines = raw.trim() ? raw.trim().split("\n") : [];
  let ok = 0, fail = 0, skipped = 0;
  const rows = lines.slice().reverse().map((l) => {
    const m = l.match(/^\[([^\]]+)\]\s+(OK|FAIL|AUTH-FAIL|BLOCKED)(?:\s+->\s+(\S+))?\s*(.*)$/);
    if (!m) { skipped++; return null; }
    const [, ts, st, email, err] = m;
    if (st === "OK") ok++; else fail++;
    const badge = st === "OK" ? "ok" : st === "FAIL" ? "err" : "warn";
    return `<tr><td>${esc(ts.replace("T", " ").slice(0, 19))}</td><td>${esc(email || "—")}</td>
      <td><span class="badge ${badge}">${st}</span></td><td style="color:var(--muted)">${esc(err.replace(/^::\s*/, ""))}</td></tr>`;
  }).filter(Boolean).join("");
  const total = ok + fail;
  const rate = total ? Math.round((ok / total) * 100) : 0;

  const body = `
  <div class="card">
    <div class="card-head"><div class="card-ic">📊</div><h2>Delivery Report</h2></div>
    <div class="sub">Session statistics for every mail this tool has attempted.</div>
    <div class="stats">
      <div class="stat"><div class="n" style="color:var(--ok)">${ok}</div><div class="l">Delivered</div></div>
      <div class="stat"><div class="n" style="color:var(--err)">${fail}</div><div class="l">Failed / Blocked</div></div>
      <div class="stat"><div class="n">${total}</div><div class="l">Total Attempts</div></div>
      <div class="stat"><div class="n" style="color:var(--brand-ink)">${rate}%</div><div class="l">Success Rate</div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-ic">📋</div><h2>Send Log</h2></div>
    <div class="sub">${total} entries · newest first${skipped ? ` · ${skipped} older entries skipped` : ""}</div>
    ${total ? `<table>
      <thead><tr><th>Time</th><th>Recipient</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody></table>`
      : `<div class="empty">No mails sent yet. <a class="link" href="/">Go to the Dashboard →</a></div>`}
  </div>`;
  return page({ title: "Send Log", body });
}

// ---------- server ----------
let sending = false;

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pathname === "/log" ? logPage() : dashboardPage());
    return;
  }

  if (req.method === "POST" && pathname === "/preflight") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const d = JSON.parse(body);
        const recipients = parseRecipients(d.recipients);
        const report = await preflight(d.user, recipients, d.subject, d.body, d.options || {});
        json(res, 200, { ok: true, report });
      } catch (e) {
        json(res, 500, { ok: false, message: "Preflight error: " + e.message });
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/send") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (sending) return json(res, 429, { ok: false, message: "A send is already in progress — please wait for it to finish." });
      sending = true;
      try {
        const d = JSON.parse(body);
        const opts = d.options || {};
        const delay = Math.max(500, Math.min(10000, parseInt(opts.delay, 10) || 1500));
        const dailyLimit = Math.max(1, Math.min(500, parseInt(opts.dailyLimit, 10) || 100));
        const warmup = parseInt(opts.warmup, 10) || 0;

        let recipients = parseRecipients(d.recipients);
        if (!d.user || !d.pass)
          return json(res, 400, { ok: false, message: "Email address and App Password are both required." });
        if (recipients.length === 0)
          return json(res, 400, { ok: false, message: "No valid recipients found — check the list format." });
        if (!d.subject || !d.body)
          return json(res, 400, { ok: false, message: "Subject and Body are both required." });

        // ---- Spam Shield gate: score ----
        const sc = spamScore(d.subject, d.body);
        if (opts.blockHigh && sc.score > 6) {
          const detail = sc.issues.slice(0, 5).map((i) => `- [${i.pts}] ${i.msg}`).join("\n");
          log(`BLOCKED :: score ${sc.score}/10 (grade ${sc.grade}) :: ${sc.issues.map((i) => i.msg).join(" | ")}`);
          return json(res, 422, {
            ok: false,
            message: `🛡️ Spam Shield blocked this send — score ${sc.score}/10 (Grade ${sc.grade}: ${sc.label}).\n\nFix these first:\n${detail}\n\n(Or uncheck "Block send if spam score is high" in Send Options.)`,
          });
        }

        // ---- Spam Shield gate: daily cap ----
        const used = sentToday();
        if (used >= dailyLimit) {
          log(`BLOCKED :: daily limit ${used}/${dailyLimit}`);
          return json(res, 429, { ok: false, message: `🛡️ Daily limit reached (${used}/${dailyLimit}). Wait until tomorrow or raise the cap (Gmail max ~500/day).` });
        }
        let quotaLeft = dailyLimit - used;

        // ---- Spam Shield gate: MX validation ----
        let mxSkipped = [];
        if (opts.requireMx) {
          const domains = [...new Set(recipients.map((r) => r.email.split("@")[1]).filter(Boolean))];
          const checks = await Promise.all(domains.map(async (dd) => [dd, await checkMx(dd)]));
          const dead = new Set(checks.filter(([, c]) => !c.ok).map(([dd]) => dd));
          if (dead.size) {
            mxSkipped = recipients.filter((r) => dead.has(r.email.split("@")[1])).map((r) => r.email);
            recipients = recipients.filter((r) => !dead.has(r.email.split("@")[1]));
            log(`MX-SKIP :: ${mxSkipped.length} address(es) on dead domains: ${mxSkipped.join(", ")}`);
          }
          if (recipients.length === 0)
            return json(res, 422, { ok: false, message: "🛡️ All recipients are on domains with no MX records — every mail would bounce. Fix the list first." });
        }

        // ---- warm-up batch limit ----
        let warmNote = "";
        if (warmup > 0 && recipients.length > warmup) {
          const dropped = recipients.length - warmup;
          recipients = recipients.slice(0, warmup);
          warmNote = `\n\n🔥 Warm-up mode: sending first ${warmup} mails only (${dropped} held back). Run again later for the rest.`;
        }
        if (recipients.length > quotaLeft) {
          const held = recipients.length - quotaLeft;
          recipients = recipients.slice(0, quotaLeft);
          warmNote += `\n\n📦 Daily cap: holding back ${held} mail(s) — only ${quotaLeft} left in today's quota.`;
        }

        const user = d.user.trim();
        const pass = String(d.pass).replace(/\s/g, "");
        const domain = user.split("@")[1] || "gmail.com";

        const transporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 587,
          secure: false,
          auth: { user, pass },
          pool: false,
          connectionTimeout: 20000,
          greetingTimeout: 15000,
          tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        });

        try {
          await transporter.verify();
        } catch (e) {
          const msg = /Invalid login|Username and Password/i.test(e.message)
            ? "SMTP authentication failed: the App Password is incorrect (or 2-Step Verification is OFF). Create a new code at Google Account → Security → App passwords."
            : "SMTP error: " + e.message;
          log(`AUTH-FAIL :: ${e.message}`);
          return json(res, 401, { ok: false, message: msg });
        }

        const footer = d.footer
          ? "\n\n---\nIf you no longer wish to receive these mails, simply reply with \"STOP\" and we won't contact you again."
          : "";
        const fromName = user.split("@")[0].replace(/[<>"]/g, "");
        const useHtml = opts.format === "html";

        let okCount = 0, failCount = 0;
        const failures = [];

        for (let i = 0; i < recipients.length; i++) {
          const r = recipients[i];
          const text = personalize(d.body + footer, r.name, r.email);
          const subject = personalize(d.subject, r.name, r.email);
          try {
            const msg = {
              from: `"${fromName}" <${user}>`,
              to: r.name ? `"${r.name.replace(/[<>"]/g, "")}" <${r.email}>` : r.email,
              replyTo: user,
              subject,
              text,
              messageId: `<${crypto.randomBytes(16).toString("hex")}@${domain}>`,
              headers: {
                "X-Mailer": `MailForge ${VERSION}`,
                "X-Priority": "3",
                "Precedence": "bulk",
                ...(d.footer ? {
                  "List-Unsubscribe": `<mailto:${user}?subject=STOP>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                } : {}),
              },
            };
            if (useHtml) msg.html = textToHtml(text); // multipart/alternative = best practice
            await transporter.sendMail(msg);
            okCount++;
            log(`OK   -> ${r.email}`);
          } catch (e) {
            failCount++;
            failures.push(`${r.email}: ${e.message}`);
            log(`FAIL -> ${r.email} :: ${e.message}`);
          }
          if (i < recipients.length - 1) await new Promise((r2) => setTimeout(r2, delay));
        }

        bumpToday(okCount);

        let msg = `Done! ✅ Delivered: ${okCount}   ❌ Failed: ${failCount}`;
        msg += `\n\n🛡️ Spam score: ${sc.score}/10 (Grade ${sc.grade})`;
        if (mxSkipped.length) msg += `\n\nMX check skipped ${mxSkipped.length} dead address(es):\n` + mxSkipped.slice(0, 8).join("\n");
        if (sc.issues.length && sc.score > 2) msg += "\n\nSuggestions:\n" + sc.issues.slice(0, 4).map((i) => "- " + i.msg).join("\n");
        if (failures.length) msg += "\n\nFailures:\n" + failures.slice(0, 8).join("\n");
        msg += warmNote;
        msg += `\n\nToday: ${used + okCount}/${dailyLimit} mails sent.`;
        msg += "\n\nFull report: /log";
        json(res, 200, { ok: okCount > 0, sent: okCount, usedToday: used + okCount, total: recipients.length, message: msg });
      } catch (e) {
        json(res, 500, { ok: false, message: "Error: " + e.message });
      } finally {
        sending = false;
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  MailForge ${VERSION} running -> http://localhost:${PORT}\n`);
});
