"use strict";

/* ---------------- Tauri bindings (with safe fallbacks) ---------------- */
const TAURI = window.__TAURI__ || {};
const invoke = TAURI.core ? TAURI.core.invoke : async () => { throw new Error("Tauri not available"); };
const dialogOpen = TAURI.dialog ? TAURI.dialog.open : null;
const openUrl = TAURI.opener ? TAURI.opener.openUrl : (u) => window.open(u, "_blank");
const listen = TAURI.event ? TAURI.event.listen : null;

/* ---------------- State ---------------- */
const state = {
  account: null,
  rootId: null,
  folder: null,            // current folder data object
  stack: [],               // [{id, name}] breadcrumb trail
  selection: new Set(),
  sortKey: "name",
  sortDir: 1,
  filter: "",
  searchMode: false,
  concurrency: Number(localStorage.getItem("gf_concurrency") || 4),
  rendered: [],          // children currently shown (sorted/filtered), for index math
  lastIndex: -1,         // anchor for shift-range selection
  clipboard: null,       // { mode: "copy" | "cut", ids: [] }
};

/* ---------------- Small helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function fmtDate(sec) {
  if (!sec) return "—";
  try { return new Date(sec * 1000).toLocaleString(); } catch { return "—"; }
}

/* ---------------- Toasts ---------------- */
function toast(msg, type = "info", ms = 3500) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 200); }, ms);
}

/* ---------------- Modal system ---------------- */
function openModal(buildBody) {
  return new Promise((resolve) => {
    const host = $("#modal-host");
    host.classList.remove("hidden");
    host.innerHTML = "";
    const modal = document.createElement("div");
    modal.className = "modal";
    host.appendChild(modal);
    const close = (val) => { host.classList.add("hidden"); host.innerHTML = ""; resolve(val); };
    buildBody(modal, close);
    host.onclick = (e) => { if (e.target === host) close(null); };
  });
}

function confirmDialog(title, message, danger = false) {
  return openModal((modal, close) => {
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="modal-body">${escapeHtml(message)}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-no>Cancel</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${danger ? "Delete" : "OK"}</button>
      </div>`;
    modal.querySelector("[data-no]").onclick = () => close(false);
    modal.querySelector("[data-yes]").onclick = () => close(true);
  });
}

// fields: [{name, label, type, value, placeholder, options}]
function promptForm(title, fields, okLabel = "Save") {
  return openModal((modal, close) => {
    const body = fields.map((f) => {
      if (f.type === "checkbox") {
        return `<label class="row-check"><input type="checkbox" data-f="${f.name}" ${f.value ? "checked" : ""}/> ${escapeHtml(f.label)}</label>`;
      }
      if (f.type === "select") {
        const opts = (f.options || []).map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === f.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
        return `<label>${escapeHtml(f.label)}</label><select data-f="${f.name}">${opts}</select>`;
      }
      if (f.type === "textarea") {
        return `<label>${escapeHtml(f.label)}</label><textarea data-f="${f.name}" rows="3" placeholder="${escapeHtml(f.placeholder || "")}">${escapeHtml(f.value || "")}</textarea>`;
      }
      return `<label>${escapeHtml(f.label)}</label><input type="${f.type || "text"}" data-f="${f.name}" value="${escapeHtml(f.value ?? "")}" placeholder="${escapeHtml(f.placeholder || "")}"/>`;
    }).join("");
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-no>Cancel</button>
        <button class="btn btn-primary" data-yes>${escapeHtml(okLabel)}</button>
      </div>`;
    const collect = () => {
      const out = {};
      modal.querySelectorAll("[data-f]").forEach((inp) => {
        out[inp.dataset.f] = inp.type === "checkbox" ? inp.checked : inp.value;
      });
      return out;
    };
    modal.querySelector("[data-no]").onclick = () => close(null);
    modal.querySelector("[data-yes]").onclick = () => close(collect());
    const first = modal.querySelector("[data-f]");
    if (first && first.focus) first.focus();
    modal.addEventListener("keydown", (e) => { if (e.key === "Enter" && first && first.tagName !== "TEXTAREA") close(collect()); });
  });
}

function linkDialog(title, url, secondLabel, secondUrl) {
  return openModal((modal, close) => {
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3>
      <div class="modal-body">
        <div class="copyfield">
          <input type="text" readonly value="${escapeHtml(url)}"/>
          <button class="btn" data-copy>Copy</button>
          <button class="btn btn-primary" data-open>Open</button>
        </div>
        ${secondUrl ? `<label>${escapeHtml(secondLabel)}</label><div class="copyfield"><input type="text" readonly value="${escapeHtml(secondUrl)}"/><button class="btn" data-copy2>Copy</button></div>` : ""}
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-no>Close</button></div>`;
    modal.querySelector("[data-copy]").onclick = () => { navigator.clipboard.writeText(url); toast("Copied", "success"); };
    modal.querySelector("[data-open]").onclick = () => openUrl(url);
    if (secondUrl) modal.querySelector("[data-copy2]").onclick = () => { navigator.clipboard.writeText(secondUrl); toast("Copied", "success"); };
    modal.querySelector("[data-no]").onclick = () => close(null);
  });
}

/* ---------------- Connect / account ---------------- */
async function tryAutoConnect() {
  try {
    const token = await invoke("load_token");
    if (token) {
      $("#token-input").value = token;
      await doConnect(token, false);
    }
  } catch { /* ignore */ }
}

async function doConnect(token, remember) {
  $("#connect-error").textContent = "";
  $("#connect-btn").disabled = true;
  try {
    const account = await invoke("connect", { token });
    state.account = account;
    if (remember) await invoke("save_token", { token });
    renderAccount(account);
    $("#connect-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    state.rootId = account.rootFolder || (await invoke("root_folder"));
    state.stack = [];
    await openFolder(state.rootId, "root", true);
  } catch (e) {
    $("#connect-error").textContent = String(e);
  } finally {
    $("#connect-btn").disabled = false;
  }
}

function renderAccount(a) {
  const email = a.email || "account";
  $("#acct-email").textContent = email;
  $("#acct-avatar").textContent = (email[0] || "G").toUpperCase();
  $("#acct-tier").textContent = a.tier || "—";
  const stats = a.statsCurrent || {};
  const used = Number(stats.storage || 0);
  const limit = Number(a.subscriptionLimitStorage || 0);
  $("#storage-fill").style.width = limit ? `${Math.min(100, (used / limit) * 100).toFixed(1)}%` : "0%";
  $("#storage-label").textContent = `${fmtBytes(used)} / ${limit ? fmtBytes(limit) : "∞"}`;
  $("#acct-stats").innerHTML = `<span><b>${stats.fileCount ?? "—"}</b> files</span><span><b>${stats.folderCount ?? "—"}</b> folders</span>`;
}

/* ---------------- Folder browsing ---------------- */
async function openFolder(id, name, resetStack = false) {
  try {
    const data = await invoke("list_folder", { contentId: id });
    state.folder = data;
    state.searchMode = false;
    $("#search-view").classList.add("hidden");
    state.selection.clear();
    updateBulkBar();
    // maintain breadcrumb trail
    if (resetStack) {
      state.stack = [{ id, name: data.name || name || "root" }];
    } else {
      const idx = state.stack.findIndex((c) => c.id === id);
      if (idx >= 0) state.stack = state.stack.slice(0, idx + 1);
      else state.stack.push({ id, name: data.name || name || "folder" });
    }
    renderBreadcrumb();
    renderRows();
  } catch (e) {
    toast(String(e), "error", 6000);
  }
}

function childrenArray(folder) {
  if (!folder) return [];
  const children = folder.children || {};
  let arr;
  if (Array.isArray(folder.childrenIds) && folder.childrenIds.length) {
    arr = folder.childrenIds.map((cid) => children[cid]).filter(Boolean);
  } else {
    arr = Object.values(children);
  }
  return arr;
}

function sortedFiltered() {
  let arr = childrenArray(state.folder);
  const f = state.filter.trim().toLowerCase();
  if (f) arr = arr.filter((c) => (c.name || "").toLowerCase().includes(f) || (c.tags || "").toLowerCase().includes(f));
  const k = state.sortKey, dir = state.sortDir;
  arr.sort((a, b) => {
    // folders first
    const fa = a.type === "folder" ? 0 : 1, fb = b.type === "folder" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    let va = a[k], vb = b[k];
    if (k === "name" || k === "type") { va = (va || "").toString().toLowerCase(); vb = (vb || "").toString().toLowerCase(); return va < vb ? -dir : va > vb ? dir : 0; }
    return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
  });
  return arr;
}

function renderBreadcrumb() {
  const bc = $("#breadcrumb");
  bc.innerHTML = "";
  state.stack.forEach((c, i) => {
    if (i > 0) { const sep = document.createElement("span"); sep.className = "crumb-sep"; sep.textContent = "›"; bc.appendChild(sep); }
    const span = document.createElement("span");
    span.className = "crumb" + (i === state.stack.length - 1 ? " current" : "");
    span.textContent = c.name || "folder";
    if (i !== state.stack.length - 1) span.onclick = () => openFolder(c.id, c.name);
    bc.appendChild(span);
  });
}

function pageUrl(child) {
  if (child.type === "folder" && child.code) return `https://gofile.io/d/${child.code}`;
  return child.link || (child.code ? `https://gofile.io/d/${child.code}` : null);
}

function renderRows() {
  const rows = $("#rows");
  rows.innerHTML = "";
  const arr = sortedFiltered();
  state.rendered = arr;
  $("#empty").classList.toggle("hidden", arr.length > 0);
  const cutSet = state.clipboard && state.clipboard.mode === "cut" ? new Set(state.clipboard.ids) : new Set();

  arr.forEach((c, index) => {
    const isFolder = c.type === "folder";
    const row = document.createElement("div");
    row.className = "row" + (state.selection.has(c.id) ? " selected" : "") + (cutSet.has(c.id) ? " cut" : "");
    row.dataset.id = c.id;
    row.dataset.index = String(index);
    const count = isFolder && (c.childrenCount != null) ? `<span class="count">${c.childrenCount}</span>` : "";
    const pub = c.public
      ? `<span class="badge badge-public">public</span>`
      : `<span class="badge badge-private">private</span>`;
    const sizeOrCount = isFolder
      ? (c.childrenCount != null ? `${c.childrenCount} items` : "—")
      : fmtBytes(c.size);

    row.innerHTML = `
      <label class="cb"><input type="checkbox" ${state.selection.has(c.id) ? "checked" : ""}/></label>
      <div class="name-cell">
        <div class="name-icon">${isFolder ? "📁" : fileIcon(c)}${count}</div>
        <div class="name-main">
          <div class="name-title ${isFolder ? "folder" : "file"}" title="${escapeHtml(c.name)}">${escapeHtml(c.name || "(unnamed)")}</div>
          <div class="name-sub">${pub}${c.mimetype ? `<span class="badge badge-private">${escapeHtml(c.mimetype)}</span>` : ""}</div>
        </div>
      </div>
      <div class="meta-cell">${fmtDate(c.createTime)}</div>
      <div class="size-cell">${sizeOrCount}</div>
      <div class="actions-cell">
        <button class="btn btn-sm" data-act="open">${isFolder ? "Open" : "View"}</button>
        ${isFolder ? "" : `<button class="btn btn-sm" data-act="download">Download</button>`}
        <button class="btn btn-sm btn-icon" data-act="menu">⋮</button>
      </div>`;

    // explicit checkbox still works
    row.querySelector(".cb input").onclick = (e) => e.stopPropagation();
    row.querySelector(".cb input").onchange = (e) => { toggleSelect(c.id, e.target.checked); row.classList.toggle("selected", e.target.checked); state.lastIndex = index; };

    // Explorer-style click selection (ignore clicks on buttons / checkbox)
    row.onclick = (e) => {
      if (e.target.closest("button") || e.target.closest(".cb")) return;
      handleRowClick(index, c.id, e);
    };
    row.ondblclick = (e) => {
      if (e.target.closest("button") || e.target.closest(".cb")) return;
      isFolder ? openFolder(c.id, c.name) : openInBrowser(c);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selection.has(c.id)) selectOnly(c.id, index);
      showContextMenu(e.clientX, e.clientY, rowMenuItems());
    };

    // action buttons
    row.querySelector('[data-act="open"]').onclick = (e) => { e.stopPropagation(); isFolder ? openFolder(c.id, c.name) : openInBrowser(c); };
    const dl = row.querySelector('[data-act="download"]');
    if (dl) dl.onclick = (e) => { e.stopPropagation(); openInBrowser(c); };
    row.querySelector('[data-act="menu"]').onclick = (e) => {
      e.stopPropagation();
      if (!state.selection.has(c.id)) selectOnly(c.id, index);
      const r = e.target.getBoundingClientRect();
      showContextMenu(r.right, r.bottom, rowMenuItems());
    };

    rows.appendChild(row);
  });
  $("#select-all").checked = arr.length > 0 && arr.every((c) => state.selection.has(c.id));
}

/* ---------------- Explorer-style selection ---------------- */
function handleRowClick(index, id, e) {
  if (e.shiftKey && state.lastIndex >= 0) {
    const [a, b] = [state.lastIndex, index].sort((x, y) => x - y);
    if (!e.ctrlKey) state.selection.clear();
    for (let i = a; i <= b; i++) state.selection.add(state.rendered[i].id);
  } else if (e.ctrlKey) {
    state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
    state.lastIndex = index;
  } else {
    selectOnly(id, index);
    return;
  }
  updateBulkBar();
  renderRows();
}

function selectOnly(id, index) {
  state.selection.clear();
  state.selection.add(id);
  state.lastIndex = index ?? -1;
  updateBulkBar();
  renderRows();
}

function selectedItems() {
  return state.rendered.filter((c) => state.selection.has(c.id));
}

function fileIcon(c) {
  const m = (c.mimetype || "").split("/")[0];
  return { image: "🖼️", video: "🎞️", audio: "🎵", text: "📄", application: "📦" }[m] || "📄";
}

function openInBrowser(child) {
  const url = pageUrl(child);
  if (url) openUrl(url);
  else toast("No public link available for this item.", "error");
}

/* ---------------- Context menus ---------------- */
// Build and show a floating menu at viewport coords from an items array:
//   ["Label", handler, { danger, accel }]  or  ["sep"]
function showContextMenu(x, y, items) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "menu context";
  for (const it of items) {
    if (it[0] === "sep") { const s = document.createElement("div"); s.className = "sep"; menu.appendChild(s); continue; }
    const [label, handler, opts = {}] = it;
    const b = document.createElement("button");
    b.innerHTML = `<span>${escapeHtml(label)}</span>${opts.accel ? `<span class="accel">${escapeHtml(opts.accel)}</span>` : ""}`;
    if (opts.danger) b.className = "danger";
    if (opts.disabled) { b.disabled = true; b.classList.add("disabled"); }
    else b.onclick = () => { closeMenus(); handler(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // keep on-screen
  const r = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = Math.min(y, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  setTimeout(() => document.addEventListener("mousedown", onDocClose, true), 0);
}
function onDocClose(e) { if (!e.target.closest(".menu.context")) closeMenus(); }
function closeMenus() { $$(".menu").forEach((m) => m.remove()); document.removeEventListener("mousedown", onDocClose, true); }

// Items for the current selection (one or many).
function rowMenuItems() {
  const sel = selectedItems();
  const ids = sel.map((c) => c.id);
  const single = sel.length === 1 ? sel[0] : null;
  const isFolder = single && single.type === "folder";
  const items = [];

  if (single) {
    items.push([single.type === "folder" ? "Open" : "View", () => single.type === "folder" ? openFolder(single.id, single.name) : openInBrowser(single), { accel: "Enter" }]);
  }
  items.push(["Cut", () => setClipboard(ids, "cut"), { accel: "Ctrl+X" }]);
  items.push(["Copy", () => setClipboard(ids, "copy"), { accel: "Ctrl+C" }]);
  items.push(["sep"]);
  if (single) items.push(["Rename", () => renameItem(single), { accel: "F2" }]);
  items.push(["Create direct link", () => ids.forEach(makeDirectLink)]);
  if (single) items.push(["Copy ID", () => { navigator.clipboard.writeText(single.id); toast("ID copied", "success"); }]);
  items.push(["Make public", () => ids.forEach((id) => setAttr(id, "public", "true", "Set public")) ]);
  items.push(["Make private", () => ids.forEach((id) => setAttr(id, "public", "false", "Set private")) ]);
  if (isFolder) {
    items.push(["sep"]);
    items.push(["Set description…", () => editAttr(single.id, "description", "Description", single.description)]);
    items.push(["Set tags…", () => editAttr(single.id, "tags", "Tags (comma separated)", single.tags)]);
    items.push(["Set password…", () => editAttr(single.id, "password", "Password", "")]);
    items.push(["Set expiry…", () => editAttr(single.id, "expiry", "Expiry (unix timestamp)", single.expire)]);
  }
  items.push(["sep"]);
  items.push(["Delete", () => deleteItems(ids), { danger: true, accel: "Del" }]);
  if (single) { items.push(["sep"]); items.push(["Properties", () => propsDialog(single)]); }
  return items;
}

// Items for the empty folder background.
function backgroundMenuItems() {
  const hasClip = state.clipboard && state.clipboard.ids.length;
  return [
    ["New folder", () => createFolder()],
    ["Upload files", () => pickAndUpload()],
    ["sep"],
    ["Paste", () => pasteHere(), { accel: "Ctrl+V", disabled: !hasClip }],
    ["sep"],
    ["Select all", () => selectAll(), { accel: "Ctrl+A" }],
    ["Refresh", () => reloadCurrent(), { accel: "F5" }],
  ];
}

/* ---------------- Clipboard (cut / copy / paste) ---------------- */
function setClipboard(ids, mode) {
  state.clipboard = { ids: [...ids], mode };
  toast(`${mode === "cut" ? "Cut" : "Copied"} ${ids.length} item(s) — open a folder and paste (Ctrl+V)`, "info");
  updateBulkBar();
  renderRows();
}

async function pasteHere() {
  const clip = state.clipboard;
  if (!clip || !clip.ids.length) return;
  const dest = state.stack[state.stack.length - 1].id;
  try {
    if (clip.mode === "cut") {
      await invoke("move_contents", { contentIds: clip.ids, destFolderId: dest });
      state.clipboard = null;
      toast("Moved here", "success");
    } else {
      await invoke("copy_contents", { contentIds: clip.ids, destFolderId: dest });
      toast("Copied here", "success");
    }
    await reloadCurrent();
  } catch (e) { toast(String(e), "error", 6000); }
}

function selectAll() {
  state.rendered.forEach((c) => state.selection.add(c.id));
  updateBulkBar();
  renderRows();
}

/* ---------------- Selection / bulk ---------------- */
function toggleSelect(id, on) { on ? state.selection.add(id) : state.selection.delete(id); updateBulkBar(); }
function updateBulkBar() {
  const n = state.selection.size;
  $("#bulkbar").classList.toggle("hidden", n === 0);
  $("#bulk-count").textContent = `${n} selected`;
  const paste = $("#bulk-paste");
  if (paste) paste.disabled = !(state.clipboard && state.clipboard.ids.length);
}

/* ---------------- Actions ---------------- */
async function reloadCurrent() {
  const cur = state.stack[state.stack.length - 1];
  if (cur) {
    const idx = state.stack.length - 1;
    await openFolder(cur.id, cur.name);
    state.stack = state.stack.slice(0, idx + 1);
    renderBreadcrumb();
  }
  refreshAccountQuietly();
}

async function refreshAccountQuietly() {
  try { const a = await invoke("refresh_account"); state.account = a; renderAccount(a); } catch { /* ignore */ }
}

async function renameItem(c) {
  const v = await promptForm("Rename", [{ name: "name", label: "New name", value: c.name }], "Rename");
  if (!v || !v.name || v.name === c.name) return;
  await setAttr(c.id, "name", v.name, "Renamed");
}

async function editAttr(id, attribute, label, current) {
  const v = await promptForm(`Set ${attribute}`, [{ name: "value", label, value: current || "", type: attribute === "description" ? "textarea" : "text" }], "Save");
  if (v == null) return;
  await setAttr(id, attribute, v.value, "Updated");
}

async function setAttr(id, attribute, value, okMsg) {
  try { await invoke("update_content", { contentId: id, attribute, value: String(value) }); toast(okMsg || "Updated", "success"); await reloadCurrent(); }
  catch (e) { toast(String(e), "error", 6000); }
}

async function deleteItems(ids) {
  const ok = await confirmDialog("Delete", `Permanently delete ${ids.length} item(s)? Folders delete all their contents. This cannot be undone.`, true);
  if (!ok) return;
  try { await invoke("delete_contents", { contentIds: ids }); toast("Deleted", "success"); state.selection.clear(); await reloadCurrent(); }
  catch (e) { toast(String(e), "error", 6000); }
}

async function makeDirectLink(id) {
  try {
    const link = await invoke("create_direct_link", { contentId: id, options: {} });
    const url = link.directLink || (link.extra && link.extra.directLink) || "";
    if (url) await linkDialog("Direct link created", url);
    else { toast("Direct link created", "success"); propsDialog(link); }
    await reloadCurrent();
  } catch (e) { toast(String(e), "error", 6000); }
}

function propsDialog(obj) {
  return openModal((modal, close) => {
    modal.innerHTML = `<h3>Properties</h3>
      <div class="modal-body"><textarea readonly rows="12" style="font-family:monospace;font-size:12px">${escapeHtml(JSON.stringify(obj, null, 2))}</textarea></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-no>Close</button></div>`;
    modal.querySelector("[data-no]").onclick = () => close(null);
  });
}

async function createFolder() {
  const v = await promptForm("New folder", [
    { name: "name", label: "Folder name (optional)", value: "" },
    { name: "public", label: "Public", type: "checkbox", value: false },
  ], "Create");
  if (v == null) return;
  const parent = state.stack[state.stack.length - 1].id;
  try {
    await invoke("create_folder", { parentFolderId: parent, folderName: v.name || null, public: !!v.public });
    toast("Folder created", "success");
    await reloadCurrent();
  } catch (e) { toast(String(e), "error", 6000); }
}

async function pickAndUpload() {
  if (!dialogOpen) { toast("File dialog unavailable.", "error"); return; }
  const selected = await dialogOpen({ multiple: true, title: "Select files to upload" });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  await uploadPaths(paths);
}

async function uploadPaths(paths) {
  if (!paths || !paths.length) return;
  const parent = state.stack[state.stack.length - 1].id;
  toast(`Uploading ${paths.length} file(s)…`, "info");
  try {
    const report = await invoke("upload_files", { paths, folderId: parent, concurrency: state.concurrency });
    const ok = report.filter((r) => r.ok).length;
    const bad = report.length - ok;
    toast(`Uploaded ${ok}/${report.length}${bad ? `, ${bad} failed` : ""}`, bad ? "error" : "success", 5000);
    report.filter((r) => !r.ok).forEach((r) => toast(`Failed: ${r.path.split(/[\\/]/).pop()} — ${r.error}`, "error", 7000));
    await reloadCurrent();
  } catch (e) { toast(String(e), "error", 6000); }
}

async function runSearch() {
  const q = $("#search-input").value.trim();
  if (!q) return;
  const parent = state.stack[state.stack.length - 1].id;
  try {
    const data = await invoke("search_contents", { contentId: parent, query: q });
    state.folder = data;
    state.selection.clear();
    updateBulkBar();
    renderRows();
    toast(`Search results in this folder`, "info");
  } catch (e) { toast(String(e), "error", 6000); }
}

/* ---------------- Wiring ---------------- */
function wire() {
  // Connect screen
  $("#connect-btn").onclick = () => doConnect($("#token-input").value, $("#remember-token").checked);
  $("#token-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#connect-btn").click(); });

  // Sidebar
  $("#disconnect-btn").onclick = async () => {
    await invoke("disconnect").catch(() => {});
    await invoke("clear_token").catch(() => {});
    state.account = null;
    $("#app").classList.add("hidden");
    $("#connect-screen").classList.remove("hidden");
    $("#token-input").value = "";
  };
  $("#reset-token-btn").onclick = async () => {
    const ok = await confirmDialog("Reset API token", "This invalidates your current token immediately and emails you a new one. The app will disconnect. Continue?", true);
    if (!ok) return;
    try {
      await invoke("reset_token");
      await invoke("clear_token").catch(() => {});
      toast("Token reset — check your email for the new one.", "success", 7000);
      $("#disconnect-btn").click();
    } catch (e) { toast(String(e), "error", 6000); }
  };
  $("#nav-root").onclick = () => { state.stack = []; openFolder(state.rootId, "root", true); setNav("browse"); };
  $$(".nav-item[data-view]").forEach((b) => b.onclick = () => setNav(b.dataset.view));

  // Topbar
  $("#refresh-btn").onclick = () => reloadCurrent();
  $("#copy-folder-id").onclick = () => {
    const cur = state.stack[state.stack.length - 1];
    if (cur) { navigator.clipboard.writeText(cur.id); toast("Folder ID copied", "success"); }
  };

  // Toolbar
  $("#upload-btn").onclick = pickAndUpload;
  $("#create-folder-btn").onclick = createFolder;
  $("#filter-input").addEventListener("input", (e) => { state.filter = e.target.value; renderRows(); });
  $("#sort-select").onchange = (e) => { state.sortKey = e.target.value; renderRows(); };
  $("#sort-dir").onclick = () => { state.sortDir *= -1; $("#sort-dir").textContent = state.sortDir === 1 ? "⬍" : "⬏"; renderRows(); };

  // Select all
  $("#select-all").onchange = (e) => {
    const arr = sortedFiltered();
    if (e.target.checked) arr.forEach((c) => state.selection.add(c.id));
    else state.selection.clear();
    updateBulkBar(); renderRows();
  };

  // Bulk actions
  $$('[data-bulk]').forEach((b) => b.onclick = () => {
    const m = b.dataset.bulk;
    if (m === "paste") { pasteHere(); return; }
    const ids = Array.from(state.selection);
    if (!ids.length) return;
    if (m === "delete") deleteItems(ids);
    else if (m === "cut") setClipboard(ids, "cut");
    else if (m === "copy") setClipboard(ids, "copy");
    else if (m === "directlink") ids.forEach((id) => makeDirectLink(id));
  });
  $("#bulk-clear").onclick = () => { state.selection.clear(); updateBulkBar(); renderRows(); };

  // Search view
  $("#search-go").onclick = runSearch;
  $("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

  // Drag & drop (Tauri native)
  if (listen) {
    listen("tauri://drag-enter", () => $("#drop-overlay").classList.remove("hidden"));
    listen("tauri://drag-leave", () => $("#drop-overlay").classList.add("hidden"));
    listen("tauri://drag-drop", (e) => {
      $("#drop-overlay").classList.add("hidden");
      const paths = (e.payload && e.payload.paths) || [];
      if (paths.length) uploadPaths(paths);
    });
  }

  // Suppress the native webview right-click menu everywhere.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // Right-click on the folder background (not on a row) → background menu.
  $("#content").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".row")) return; // rows handle their own
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, backgroundMenuItems());
  });
  // Clicking empty space clears the selection.
  $("#content").addEventListener("mousedown", (e) => {
    if (e.button === 0 && !e.target.closest(".row") && !e.target.closest(".list-head")) {
      state.selection.clear(); state.lastIndex = -1; updateBulkBar(); renderRows();
    }
  });

  // Keyboard shortcuts (Explorer-style)
  document.addEventListener("keydown", onKeyDown);
}

function typingInField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function onKeyDown(e) {
  // Only active while browsing and no modal is open.
  if (!$("#modal-host").classList.contains("hidden")) {
    if (e.key === "Escape") closeMenus();
    return;
  }
  if ($("#app").classList.contains("hidden")) return;

  if (e.key === "Escape") { closeMenus(); state.selection.clear(); updateBulkBar(); renderRows(); return; }

  // Ctrl+F focuses the filter even while not typing.
  if (e.ctrlKey && (e.key === "f" || e.key === "F")) { e.preventDefault(); $("#filter-input").focus(); return; }

  if (typingInField(e)) return; // let inputs handle their own keys

  const sel = selectedItems();
  const ids = sel.map((c) => c.id);

  if (e.ctrlKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); selectAll(); return; }
  if (e.ctrlKey && (e.key === "c" || e.key === "C")) { if (ids.length) setClipboard(ids, "copy"); return; }
  if (e.ctrlKey && (e.key === "x" || e.key === "X")) { if (ids.length) setClipboard(ids, "cut"); return; }
  if (e.ctrlKey && (e.key === "v" || e.key === "V")) { pasteHere(); return; }

  if (e.key === "Delete") { if (ids.length) deleteItems(ids); return; }
  if (e.key === "F2") { if (sel.length === 1) renameItem(sel[0]); return; }
  if (e.key === "F5") { e.preventDefault(); reloadCurrent(); return; }
  if (e.key === "Enter") {
    if (sel.length === 1) { sel[0].type === "folder" ? openFolder(sel[0].id, sel[0].name) : openInBrowser(sel[0]); }
    return;
  }
  // Backspace / Alt+Left → go up one folder.
  if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
    e.preventDefault();
    if (state.stack.length > 1) { const up = state.stack[state.stack.length - 2]; openFolder(up.id, up.name); }
    return;
  }
  // Arrow up/down move the single selection.
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && state.rendered.length) {
    e.preventDefault();
    let idx = state.lastIndex;
    idx = e.key === "ArrowDown" ? Math.min(state.rendered.length - 1, idx + 1) : Math.max(0, idx - 1);
    const c = state.rendered[idx];
    if (c) {
      selectOnly(c.id, idx);
      const row = $(`.row[data-index="${idx}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  }
}

function setNav(view) {
  $$(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  state.searchMode = view === "search";
  $("#search-view").classList.toggle("hidden", view !== "search");
  if (view === "browse") reloadCurrent();
}

/* ---------------- Boot ---------------- */
wire();
tryAutoConnect();
