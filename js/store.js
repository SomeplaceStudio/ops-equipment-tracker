/* ══════════════════════════════════════════════════════════════
   store.js — 以 GitHub repo 當資料庫

   讀：raw.githubusercontent.com，不需要任何權限，任何人打開連結都看得到。
   寫：GitHub Contents API，需要一組細粒度權杖（只授權這一個 repo）。

   衝突處理：資料檔每次寫入都要帶上當前的 blob SHA。別人搶先改過的話
   GitHub 會回 409，這時重新抓一次、跟本機資料合併、再送一次。
   合併是逐筆比對 updatedAt，不是整檔覆蓋——兩個人改不同項目不會互相蓋掉。
   刪除用墓碑（deleted）紀錄，否則合併時被刪掉的項目會從對方那邊復活。
   ══════════════════════════════════════════════════════════════ */

const LS_TOKEN = "ops:gh:token";
const LS_REPO  = "ops:gh:repo";
const LS_CACHE = "ops:cache:v3";
const BRANCH   = "main";
const DATA     = "data.json";
const TOMBSTONE_DAYS = 90;

/* ── repo 位置 ────────────────────────────────────────────── */
// 部署在 https://<owner>.github.io/<repo>/ 時自動推導；
// 本機開發或想指到別的 repo，就在設定面板填 owner/repo。
export function detectRepo() {
  const override = localStorage.getItem(LS_REPO);
  if (override && override.includes("/")) {
    const [owner, repo] = override.split("/");
    return { owner, repo, source: "manual" };
  }
  const h = location.hostname;
  if (h.endsWith(".github.io")) {
    const owner = h.slice(0, -".github.io".length);
    const seg = location.pathname.split("/").filter(Boolean);
    // 專案頁 → /<repo>/...；使用者頁 → 根目錄，repo 名就是 <owner>.github.io
    return { owner, repo: seg.length ? seg[0] : h, source: "auto" };
  }
  return null;
}
export const setRepo   = v => v ? localStorage.setItem(LS_REPO, v.trim()) : localStorage.removeItem(LS_REPO);
export const getToken  = () => localStorage.getItem(LS_TOKEN) || "";
export const setToken  = t => t ? localStorage.setItem(LS_TOKEN, t.trim()) : localStorage.removeItem(LS_TOKEN);
export const canEdit   = () => !!getToken();

/* ── base64（要能處理中文，btoa 只吃 latin1） ─────────────── */
export function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)          // 分段，避免 apply 爆堆疊
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64text = str => b64encode(new TextEncoder().encode(str));
const unb64text = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), c => c.charCodeAt(0)));

/* ── 空白資料 ─────────────────────────────────────────────── */
export const emptyDoc = () => ({ v: 1, items: [], deleted: [], updatedAt: 0 });

/* ── 讀 ───────────────────────────────────────────────────── */
/** 404 有兩種可能：repo 打錯，或只是還沒建 data.json。
 *  兩者的處置完全不同（前者要報錯，後者要當成空清單讓人開始新增），
 *  但 raw 對兩者都回 404，所以得再問一次 repo 本身在不在。 */
async function assertRepoExists(repo) {
  const token = getToken();
  const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (r.ok) return;
  if (r.status === 404) throw new Error(`找不到 ${repo.owner}/${repo.repo}——請確認名稱，私有 repo 則需要權杖`);
  if (r.status === 403) throw new Error("GitHub 流量限制，稍後再試（403）");
  throw new Error(await errText(r));
}

/** 沒有權杖時走 raw（無流量限制）；有權杖時走 API（即時，且順便拿到 SHA） */
export async function fetchRemote(repo) {
  const token = getToken();
  if (token) {
    const r = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${DATA}?ref=${BRANCH}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, cache: "no-store" }
    );
    if (r.status === 404) { await assertRepoExists(repo); return { doc: emptyDoc(), sha: null }; }
    if (!r.ok) throw new Error(await errText(r));
    const j = await r.json();
    return { doc: normalize(JSON.parse(unb64text(j.content))), sha: j.sha };
  }
  // 檢視者：raw + 時間戳擋 CDN 快取
  const r = await fetch(
    `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${BRANCH}/${DATA}?t=${Date.now()}`,
    { cache: "no-store" }
  );
  if (r.status === 404) { await assertRepoExists(repo); return { doc: emptyDoc(), sha: null }; }
  if (!r.ok) throw new Error(`讀取失敗 HTTP ${r.status}`);
  try { return { doc: normalize(await r.json()), sha: null }; }
  catch { throw new Error("data.json 格式壞掉，無法解析"); }
}

function normalize(d) {
  const doc = { ...emptyDoc(), ...(d || {}) };
  doc.items   = Array.isArray(doc.items)   ? doc.items   : [];
  doc.deleted = Array.isArray(doc.deleted) ? doc.deleted : [];
  return doc;
}

/* ── 合併 ─────────────────────────────────────────────────── */
/** 逐筆取 updatedAt 較新者；墓碑一律勝過比它舊的項目。 */
export function merge(a, b) {
  const byId = new Map();
  for (const it of [...a.items, ...b.items]) {
    const prev = byId.get(it.id);
    if (!prev || (it.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(it.id, it);
  }

  const tomb = new Map();
  for (const t of [...a.deleted, ...b.deleted]) {
    const prev = tomb.get(t.id);
    if (!prev || (t.at || 0) > (prev.at || 0)) tomb.set(t.id, t);
  }
  // 刪除晚於最後一次編輯 → 真的刪掉；反之視為刪除後又被改回來
  for (const [id, t] of tomb) {
    const it = byId.get(id);
    if (it && (it.updatedAt || 0) > (t.at || 0)) tomb.delete(id);
    else byId.delete(id);
  }

  // 排序必須是決定性的：order 相同時用 id 決勝負。
  // 否則合併結果會因為誰先誰後而不同，兩個人看到的排列會不一樣，
  // 寫回去的 JSON 也會每次都產生無意義的 diff。
  const byKey = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  return {
    v: 1,
    items: [...byId.values()].sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || byKey(x, y)),
    deleted: [...tomb.values()].filter(t => (t.at || 0) > cutoff).sort(byKey),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };
}

/* ── 寫 ───────────────────────────────────────────────────── */
async function errText(r) {
  let detail = "";
  try { detail = (await r.json()).message || ""; } catch {}
  if (r.status === 401) return "權杖無效或已過期（401）";
  if (r.status === 403) return detail.includes("rate limit") ? "GitHub 流量限制，稍後再試（403）" : "權杖沒有這個 repo 的寫入權限（403）";
  if (r.status === 404) return "找不到 repo，或權杖沒有存取權（404）";
  return `HTTP ${r.status}${detail ? "：" + detail : ""}`;
}

/** 送出本機資料。遇到 409（別人先改了）就重抓、合併、重試。 */
export async function push(repo, localDoc, message, tries = 4) {
  const token = getToken();
  if (!token) throw new Error("沒有編輯權杖，無法寫入");

  let doc = localDoc;
  for (let i = 0; i < tries; i++) {
    const { doc: remote, sha } = await fetchRemote(repo);
    doc = merge(doc, remote);
    doc.updatedAt = Date.now();

    const body = {
      message,
      content: b64text(JSON.stringify(doc, null, 2) + "\n"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    };
    const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${DATA}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return doc;
    if (r.status === 409 || r.status === 422) {          // 撞車，退避後重試
      await new Promise(res => setTimeout(res, 400 * (i + 1)));
      continue;
    }
    throw new Error(await errText(r));
  }
  throw new Error("連續衝突，請稍後再試");
}

/** 上傳一張照片，回傳 repo 內的相對路徑 */
export async function pushPhoto(repo, path, bytes) {
  const token = getToken();
  if (!token) throw new Error("沒有編輯權杖，無法上傳照片");
  const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: `照片 ${path}`, content: b64encode(bytes), branch: BRANCH }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return path;
}

/** 照片一律走 raw：GitHub Pages 部署有延遲，剛上傳的圖在 Pages 上還看不到 */
export const photoURL = (repo, path) =>
  /^https?:/.test(path) ? path
    : `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${BRANCH}/${path}`;

/* ── 本機快取（離線可看、開啟即顯示） ─────────────────────── */
export function loadCache() {
  try { const r = localStorage.getItem(LS_CACHE); return r ? normalize(JSON.parse(r)) : null; }
  catch { return null; }
}
export function saveCache(doc) {
  try { localStorage.setItem(LS_CACHE, JSON.stringify(doc)); } catch (e) { console.warn("快取寫入失敗", e); }
}

/** 驗證權杖真的能寫這個 repo，回傳使用者名稱 */
export async function verifyToken(repo, token) {
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const me = await fetch("https://api.github.com/user", { headers: h });
  if (!me.ok) throw new Error(await errText(me));
  const user = (await me.json()).login;
  const rr = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, { headers: h });
  if (!rr.ok) throw new Error(await errText(rr));
  const info = await rr.json();
  if (!info.permissions?.push) throw new Error(`權杖對 ${repo.owner}/${repo.repo} 只有讀取權限`);
  return user;
}
