import {
  detectRepo, setRepo, getToken, setToken, canEdit, verifyToken,
  fetchRemote, merge, push, pushPhoto, photoURL,
  loadCache, saveCache, emptyDoc, b64encode,
} from "./store.js";

/* ══ 常數 ══════════════════════════════════════════════════ */
const ZONES = ["接待區", "攝影棚區", "梳化間", "廁所", "辦公室"];
const STATUS = [
  { k: "待確認", c: "#B3A392" }, { k: "已確認選用", c: "#9A7A24" }, { k: "已下訂", c: "#B0653F" },
  { k: "已付款", c: "#7A5EA0" }, { k: "已出貨", c: "#3F7F94" }, { k: "已送達", c: "#5F7A52" },
  { k: "已安裝", c: "#41705C" }, { k: "退回重選", c: "#A44C3C" }];
const sc = k => (STATUS.find(s => s.k === k) || STATUS[0]).c;

const POLL_MS = 20000;   // 前景每 20 秒拉一次別人的改動
const PUSH_MS = 2500;    // 停手 2.5 秒才送出，避免每點一下就一個 commit

let repo = detectRepo();
let doc = loadCache() || emptyDoc();
let zone = ZONES[0];
let dirty = false, pushing = false, pollTimer = null, pushTimer = null;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const today = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}` };
const stamp = () => { const d = new Date(); return `${today()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function toast(m, ms = 2400) {
  const t = $("#toast"); t.textContent = m; t.classList.add("on");
  clearTimeout(t._); t._ = setTimeout(() => t.classList.remove("on"), ms);
}
function setSync(state, text) { $("#sync").dataset.s = state; $("#syncText").textContent = text; }

/* ══ 改動 → 本機立即生效 → 稍後推送 ═══════════════════════ */
function touch(item) {
  item.updatedAt = Date.now();
  const i = doc.items.findIndex(x => x.id === item.id);
  if (i < 0) doc.items.push(item); else doc.items[i] = item;
  commit();
}
function removeItem(id) {
  doc.items = doc.items.filter(x => x.id !== id);
  doc.deleted.push({ id, at: Date.now() });
  commit();
}
function commit() {
  doc.updatedAt = Date.now();
  saveCache(doc);
  render();
  dirty = true;
  setSync("pending", "待同步");
  clearTimeout(pushTimer);
  pushTimer = setTimeout(sync, PUSH_MS);
}

/* ══ 同步 ══════════════════════════════════════════════════ */
async function sync(manual = false) {
  if (!repo) { setSync("off", "未設定 repo"); return; }
  if (pushing) return;

  // 唯讀模式：只拉不推
  if (!canEdit()) {
    try {
      setSync("pending", "更新中⋯");
      const { doc: remote } = await fetchRemote(repo);
      doc = merge(doc, remote); saveCache(doc); render();
      setSync("view", "檢視模式");
    } catch (e) {
      console.error(e); setSync("off", navigator.onLine ? "讀取失敗" : "離線");
      if (manual) toast(e.message);
    }
    return;
  }

  pushing = true;
  try {
    if (dirty) {
      setSync("pending", "同步中⋯");
      doc = await push(repo, doc, `設備清單更新 ${stamp()}`);
      dirty = false;
    } else {
      const { doc: remote } = await fetchRemote(repo);
      doc = merge(doc, remote);
    }
    saveCache(doc); render();
    setSync("live", "已同步");
    if (manual) toast("已同步");
  } catch (e) {
    console.error(e);
    setSync("off", navigator.onLine ? "同步失敗" : "離線・改動已暫存");
    if (manual || dirty) toast(e.message, 3600);
  } finally {
    pushing = false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden && navigator.onLine) sync(); }, POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
addEventListener("online", () => sync());
addEventListener("offline", () => setSync("off", "離線・改動已暫存"));
addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ══ 繪製 ══════════════════════════════════════════════════ */
function drawGauge() {
  const items = doc.items;
  const total = items.reduce((a, i) => a + (i.price || 0) * (i.qty || 1), 0);
  $("#gTotal").innerHTML = total.toLocaleString() + '<small>NT$</small>';
  $("#gCount").textContent = items.length;
  const by = {}; items.forEach(i => by[i.status] = (by[i.status] || 0) + (i.price || 0) * (i.qty || 1));
  const on = total ? STATUS.filter(s => by[s.k]) : [];
  $("#gBar").innerHTML = on.length
    ? on.map(s => `<span style="width:${by[s.k] / total * 100}%;background:${s.c}"></span>`).join("")
    : '<span style="width:100%;background:#3A2F28"></span>';
  $("#gLegend").innerHTML = on.map(s => `<div><i style="background:${s.c}"></i>${s.k} ${Math.round(by[s.k] / total * 100)}%</div>`).join("");
}
function drawZones() {
  $("#zones").innerHTML = ZONES.map(z =>
    `<button class="zone" role="tab" aria-selected="${z === zone}" data-z="${z}">${z}<span class="n">${doc.items.filter(i => i.zone === z).length}</span></button>`).join("");
}
function replyBlock(it, role, rw) {
  const who = role === "d" ? "設計師" : "夥伴";
  const n = it[role] || { text: "", at: "", v: "" };
  const flag = n.v === "ok" ? '<span class="flag ok">已確認</span>' : n.v === "no" ? '<span class="flag no">需討論</span>' : "";
  return `<div class="reply">
    <div class="rhead"><b>${who}</b>回覆${flag}</div>
    ${n.text ? `<div class="bubble">${esc(n.text)}<span class="stamp">${n.at}</span></div>` : `<div class="bubble empty">尚未回覆</div>`}
    ${rw ? `<div class="acts">
      <button class="chip ok" aria-pressed="${n.v === "ok"}" data-vote="ok" data-role="${role}" data-id="${it.id}">✓</button>
      <button class="chip no" aria-pressed="${n.v === "no"}" data-vote="no" data-role="${role}" data-id="${it.id}">需討論</button>
      <button class="chip write" data-write="${role}" data-id="${it.id}">${n.text ? "編輯" : "寫意見"}</button>
    </div>` : ""}
  </div>`;
}
function drawList() {
  const rw = canEdit();
  document.body.classList.toggle("readonly", !rw);
  const rows = doc.items.filter(i => i.zone === zone);
  if (!rows.length) {
    $("#list").innerHTML = `<div class="empty-zone"><b>${zone}還沒有設備</b>${rw ? "按下方「新增設備」開始建檔。" : "目前是檢視模式，按右上角設定貼上權杖即可編輯。"}</div>`;
    return;
  }
  $("#list").innerHTML = rows.map(it => `
  <article class="card" data-id="${it.id}">
    ${rw ? `<div class="grip" title="拖曳排序"><svg viewBox="0 0 11 22" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="4" r="1.6"/><circle cx="8.5" cy="4" r="1.6"/><circle cx="2.5" cy="11" r="1.6"/><circle cx="8.5" cy="11" r="1.6"/><circle cx="2.5" cy="18" r="1.6"/><circle cx="8.5" cy="18" r="1.6"/></svg></div>` : ""}
    <div class="body">
      <div class="prod">
        <div class="photo">${it.img ? `<img src="${esc(photoURL(repo, it.img))}" alt="${esc(it.name)}" loading="lazy">` : "未加照片"}</div>
        <div class="brand">${esc(it.brand || "—")}</div>
        <div class="name">${esc(it.name)}</div>
        <div class="specs">
          ${it.size ? `<span class="spec">${esc(it.size)}</span>` : ""}
          ${it.color ? `<span class="spec">${esc(it.color)}</span>` : ""}
          ${it.qty > 1 ? `<span class="spec">×${it.qty}</span>` : ""}
        </div>
        <div class="price">${(it.price || 0).toLocaleString()}${it.list ? `<s>${it.list.toLocaleString()}</s>` : ""}${it.qty > 1 ? `<small>小計 ${((it.price || 0) * it.qty).toLocaleString()}</small>` : ""}</div>
        ${it.spec ? `<div class="memo">${esc(it.spec)}</div>` : ""}
        <div class="stat">
          <div class="statsel">
            <span class="dotmark" style="background:${sc(it.status)}"></span>
            ${rw
              ? `<select class="status" data-id="${it.id}" style="color:${sc(it.status)}" aria-label="${esc(it.name)} 狀態">
                   ${STATUS.map(s => `<option ${s.k === it.status ? "selected" : ""}>${s.k}</option>`).join("")}
                 </select><span class="chev">▾</span>`
              : `<span class="statictext" style="color:${sc(it.status)}">${esc(it.status)}</span>`}
          </div>
          ${(it.log || []).length ? `<div class="tl">${it.log.map(l => `<div>${l.at}<b>${l.k}</b></div>`).join("")}</div>` : ""}
        </div>
        ${it.url ? `<a class="linkbtn" href="${esc(it.url)}" target="_blank" rel="noopener">商品頁 ↗</a>` : ""}
        ${rw ? `<div class="rowacts">
          <button class="chip edit" data-edit="${it.id}">編輯</button>
          <button class="chip del" data-del="${it.id}">刪除</button>
        </div>` : ""}
      </div>
      <div class="replies">${replyBlock(it, "d", rw)}${replyBlock(it, "p", rw)}</div>
    </div>
  </article>`).join("");
}
function render() { drawGauge(); drawZones(); drawList(); }

/* ══ 互動 ══════════════════════════════════════════════════ */
document.addEventListener("click", e => {
  const z = e.target.closest("[data-z]");
  if (z) { zone = z.dataset.z; render(); return }

  const v = e.target.closest("[data-vote]");
  if (v) {
    const it = doc.items.find(i => i.id === v.dataset.id); if (!it) return;
    const n = { ...(it[v.dataset.role] || { text: "", at: "", v: "" }) };
    n.v = n.v === v.dataset.vote ? "" : v.dataset.vote; n.at = stamp();
    touch({ ...it, [v.dataset.role]: n });
    toast(n.v === "ok" ? "已標記確認" : n.v === "no" ? "已標記需討論" : "已取消標記");
    return;
  }

  const w = e.target.closest("[data-write]");
  if (w) {
    const it = doc.items.find(i => i.id === w.dataset.id); if (!it) return;
    const n = { ...(it[w.dataset.write] || { text: "", at: "", v: "" }) };
    const t = prompt(`${w.dataset.write === "d" ? "設計師" : "夥伴"}意見`, n.text || "");
    if (t === null) return;
    n.text = t.trim(); n.at = stamp();
    touch({ ...it, [w.dataset.write]: n });
    return;
  }

  const ed = e.target.closest("[data-edit]");
  if (ed) { openSheet(doc.items.find(i => i.id === ed.dataset.edit)); return }

  const dl = e.target.closest("[data-del]");
  if (dl) {
    const it = doc.items.find(i => i.id === dl.dataset.del); if (!it) return;
    if (!confirm(`刪除「${it.name}」？所有人的清單都會一起消失。`)) return;
    removeItem(it.id); toast("已刪除");
  }
});

document.addEventListener("change", e => {
  if (!e.target.matches("select.status")) return;
  const it = doc.items.find(i => i.id === e.target.dataset.id); if (!it) return;
  const status = e.target.value;
  const log = [...(it.log || [])].filter(l => l.k !== status);
  log.push({ k: status, at: today() });
  touch({ ...it, status, log: log.slice(-20) });
  toast(`${today()} ${status}`);
});

/* ══ 拖曳排序 ══════════════════════════════════════════════ */
let dragEl = null;
document.addEventListener("pointerdown", e => {
  const g = e.target.closest(".grip"); if (!g) return;
  dragEl = g.closest(".card"); dragEl.classList.add("dragging");
  dragEl.style.pointerEvents = "none"; g.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove", e => {
  if (!dragEl) return; e.preventDefault();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const over = el && el.closest(".card");
  if (over && over !== dragEl) {
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(dragEl, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  }
}, { passive: false });
document.addEventListener("pointerup", () => {
  if (!dragEl) return;
  dragEl.classList.remove("dragging"); dragEl.style.pointerEvents = "";
  dragEl = null;
  const order = [...document.querySelectorAll(".card")].map(c => c.dataset.id);
  const base = Math.min(0, ...doc.items.filter(i => i.zone === zone).map(i => i.order ?? 0));
  const now = Date.now();
  order.forEach((id, i) => {
    const it = doc.items.find(x => x.id === id);
    if (it) { it.order = base + i; it.updatedAt = now; }
  });
  commit();
});

/* ══ 照片 ══════════════════════════════════════════════════ */
let photoBytes = null, photoPreview = "", photoCleared = false;

$("#fPhoto").onchange = function () {
  const f = this.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    const im = new Image();
    im.onload = () => {
      const M = 1400, s = Math.min(1, M / Math.max(im.width, im.height));
      const c = document.createElement("canvas");
      c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      c.toBlob(async b => {
        if (!b) { toast("影像處理失敗"); return }
        photoBytes = new Uint8Array(await b.arrayBuffer());
        photoPreview = URL.createObjectURL(b);
        photoCleared = false;
        showPhoto(photoPreview, `已壓縮 ${Math.round(b.size / 1024)} KB・點擊可更換`);
      }, "image/jpeg", .82);
    };
    im.onerror = () => toast("這張圖讀不進來，換一張試試");
    im.src = r.result;
  };
  r.onerror = () => toast("檔案讀取失敗");
  r.readAsDataURL(f);
};
function showPhoto(src, hint) {
  const p = $("#prevImg"); p.src = src; p.hidden = false;
  $("#dropText").textContent = "";
  const h = $("#dropHint");
  h.textContent = hint; h.style.position = "relative"; h.style.color = "#FFFCF6";
  h.style.textShadow = "0 1px 6px rgba(0,0,0,.7)";
  $("#dropClear").hidden = false;
}
function resetPhoto() {
  if (photoPreview) URL.revokeObjectURL(photoPreview);
  photoBytes = null; photoPreview = ""; photoCleared = false;
  $("#prevImg").hidden = true; $("#prevImg").removeAttribute("src"); $("#fPhoto").value = "";
  $("#dropText").textContent = "＋ 加入照片";
  const h = $("#dropHint"); h.textContent = "拍照或從相簿選，自動壓縮";
  h.style.position = ""; h.style.color = ""; h.style.textShadow = "";
  $("#dropClear").hidden = true;
}
$("#dropClear").onclick = e => { e.stopPropagation(); resetPhoto(); photoCleared = true; toast("已移除照片") };

/* ══ 新增／編輯面板 ════════════════════════════════════════ */
const sheet = $("#sheet"), scrim = $("#scrim");
let editId = null, busy = false;

function openSheet(it) {
  editId = it ? it.id : null;
  $("#fZone").innerHTML = ZONES.map(z => `<option ${z === (it ? it.zone : zone) ? "selected" : ""}>${z}</option>`).join("");
  $("#sheetTitle").textContent = it ? "編輯設備" : "新增設備";
  $("#sheetHint").textContent = it ? "改完按下方「儲存修改」。狀態與意見不會被覆蓋。" : "照片會自動壓縮後上傳，不用先修圖。";
  $("#btnSave").textContent = it ? "儲存修改" : "加入清單";

  $("#fUrl").value = it?.url || "";
  $("#fName").value = it?.name || "";
  $("#fBrand").value = it?.brand || "";
  $("#fPrice").value = it?.price ?? "";
  $("#fQty").value = it?.qty || 1;
  $("#fSize").value = it?.size || "";
  $("#fColor").value = it?.color || "";
  $("#fSpec").value = it?.spec || "";

  resetPhoto();
  if (it?.img) showPhoto(photoURL(repo, it.img), "點擊可更換照片");

  openPanel(sheet);
}
const openPanel = el => { el.classList.add("on"); scrim.classList.add("on"); el.scrollTop = 0 };
const closeAll = () => {
  if (busy) return;
  sheet.classList.remove("on"); $("#settings").classList.remove("on");
  scrim.classList.remove("on"); editId = null;
};

$("#fab").onclick = () => openSheet(null);
$("#btnCancel").onclick = closeAll;
$("#btnCancelSet").onclick = closeAll;
$("#sync").onclick = () => sync(true);
scrim.onclick = closeAll;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeAll() });

$("#btnParse").onclick = function () {
  if (!$("#fUrl").value.trim()) { toast("先貼上商品連結"); return }
  this.disabled = true; this.innerHTML = '<span class="spin"></span> 讀取商品頁⋯';
  setTimeout(() => { this.disabled = false; this.textContent = "從連結帶入資料"; toast("這個站台擋抓取，請手動補齊") }, 1500);
};

$("#btnSave").onclick = async () => {
  if (busy) return;
  const name = $("#fName").value.trim(); if (!name) { toast("品名還沒填"); return }

  const form = {
    zone: $("#fZone").value, name,
    brand: $("#fBrand").value.trim(),
    price: +$("#fPrice").value || 0,
    qty: +$("#fQty").value || 1,
    size: $("#fSize").value.trim(),
    color: $("#fColor").value.trim(),
    spec: $("#fSpec").value.trim(),
    url: $("#fUrl").value.trim(),
  };

  const old = editId ? doc.items.find(i => i.id === editId) : null;
  const id = editId || newId();
  const btn = $("#btnSave"), label = btn.textContent;
  let img = old?.img || "";

  // 照片必須先上傳（要拿到 repo 路徑），這段一定得等
  if (photoBytes) {
    busy = true; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 上傳照片⋯';
    try {
      img = await pushPhoto(repo, `photos/${id}-${Date.now()}.jpg`, photoBytes);
    } catch (e) {
      console.error(e); busy = false; btn.disabled = false; btn.textContent = label;
      toast(navigator.onLine ? "照片上傳失敗：" + e.message : "離線中無法上傳照片，請連上網再試", 3600);
      return;
    }
    busy = false; btn.disabled = false; btn.textContent = label;
  } else if (photoCleared) {
    img = "";
  }

  if (old) {
    touch({ ...old, ...form, img });
    toast("已更新");
  } else {
    const maxOrder = doc.items.reduce((m, i) => Math.max(m, i.order ?? 0), 0);
    touch({
      id, ...form, list: null, img,
      status: "待確認", log: [],
      d: { text: "", at: "", v: "" }, p: { text: "", at: "", v: "" },
      order: maxOrder + 1,
    });
    toast("已加入清單");
  }
  zone = form.zone; render(); closeAll(); resetPhoto();
};

/* ══ 設定：權杖與 repo ═════════════════════════════════════ */
$("#btnSettings").onclick = () => {
  const r = detectRepo();
  $("#fRepo").value = r ? `${r.owner}/${r.repo}` : "";
  $("#fRepo").placeholder = "帳號/repo 名稱";
  $("#repoAuto").textContent = r ? (r.source === "auto" ? "（由網址自動判斷）" : "（手動設定）") : "（無法自動判斷，請填寫）";
  $("#fToken").value = "";
  $("#tokenState").textContent = canEdit() ? "目前：可編輯" : "目前：唯讀檢視";
  $("#tokenState").className = "tokenstate " + (canEdit() ? "on" : "");
  $("#btnForget").hidden = !canEdit();
  openPanel($("#settings"));
};
$("#btnSaveToken").onclick = async function () {
  const repoStr = $("#fRepo").value.trim();
  const tok = $("#fToken").value.trim();
  setRepo(repoStr);
  repo = detectRepo();
  if (!repo) { toast("請先填寫 帳號/repo"); return }
  if (!tok) { toast("請貼上權杖，或按「清除權杖」改回唯讀"); return }

  this.disabled = true; const label = this.textContent;
  this.innerHTML = '<span class="spin"></span> 驗證中⋯';
  try {
    const user = await verifyToken(repo, tok);
    setToken(tok);
    toast(`已啟用編輯：${user}`);
    closeAll(); render(); sync(true); startPolling();
  } catch (e) {
    console.error(e); toast(e.message, 4000);
  } finally {
    this.disabled = false; this.textContent = label;
  }
};
$("#btnForget").onclick = () => {
  setToken(""); toast("已清除權杖，回到唯讀檢視");
  closeAll(); render(); setSync("view", "檢視模式");
};
$("#btnSyncNow").onclick = () => sync(true);
$("#btnShare").onclick = async () => {
  const url = location.origin + location.pathname;
  try {
    if (navigator.share && matchMedia("(max-width:899px)").matches) await navigator.share({ title: "OPS 設備追蹤", url });
    else { await navigator.clipboard.writeText(url); toast("連結已複製・拿到的人都能檢視"); }
  } catch (e) { if (e.name !== "AbortError") prompt("複製這個連結分享出去：", url) }
};

/* ══ 啟動 ══════════════════════════════════════════════════ */
if ("serviceWorker" in navigator)
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW 未註冊", e)));

render();
if (!repo) {
  setSync("off", "未設定 repo");
  $("#list").innerHTML = `<div class="empty-zone"><b>還沒設定資料來源</b>
    在 GitHub Pages 上會自動判斷；本機開發請按右上角設定，填入 帳號/repo。</div>`;
} else {
  setSync("pending", "讀取中⋯");
  sync();
  startPolling();
}
