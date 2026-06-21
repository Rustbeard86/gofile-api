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
  $("#empty").classList.toggle("hidden", arr.length > 0);

  for (const c of arr) {
    const isFolder = c.type === "folder";
    const row = document.createElement("div");
    row.className = "row" + (state.selection.has(c.id) ? " selected" : "");
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

    // checkbox
    row.querySelector(".cb input").onchange = (e) => { toggleSelect(c.id, e.target.checked); row.classList.toggle("selected", e.target.checked); };
    // name click → open folder
    const title = row.querySelector(".name-title");
    if (isFolder) title.onclick = () => openFolder(c.id, c.name);
    // actions
    row.querySelector('[data-act="open"]').onclick = () => isFolder ? openFolder(c.id, c.name) : openInBrowser(c);
    const dl = row.querySelector('[data-act="download"]');
    if (dl) dl.onclick = () => openInBrowser(c);
    row.querySelector('[data-act="menu"]').onclick = (e) => { e.stopPropagation(); openRowMenu(row.querySelector(".actions-cell"), c); };

    rows.appendChild(row);
  }
  $("#select-all").checked = arr.length > 0 && arr.every((c) => state.selection.has(c.id));
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

/* ---------------- Row context menu ---------------- */
function openRowMenu(anchor, c) {
  closeMenus();
  const isFolder = c.type === "folder";
  const menu = document.createElement("div");
  menu.className = "menu";
  const items = [
    ["Rename", () => renameItem(c)],
    ["Direct link", () => makeDirectLink(c.id)],
    ["Copy ID", () => { navigator.clipboard.writeText(c.id); toast("ID copied", "success"); }],
    ["Move…", () => moveOrCopy([c.id], "move")],
    ["Copy to…", () => moveOrCopy([c.id], "copy")],
    ["sep"],
    ["Toggle public", () => setAttr(c.id, "public", c.public ? "false" : "true", `Set ${c.public ? "private" : "public"}`)],
  ];
  if (isFolder) {
    items.push(["Set description", () => editAttr(c.id, "description", "Description", c.description)]);
    items.push(["Set tags", () => editAttr(c.id, "tags", "Tags (comma separated)", c.tags)]);
    items.push(["Set password", () => editAttr(c.id, "password", "Password", "")]);
    items.push(["Set expiry (unix)", () => editAttr(c.id, "expiry", "Expiry (unix timestamp)", c.expire)]);
  }
  items.push(["Properties", () => propsDialog(c)]);
  items.push(["sep"]);
  items.push(["Delete", () => deleteItems([c.id]), true]);

  for (const it of items) {
    if (it[0] === "sep") { const s = document.createElement("div"); s.className = "sep"; menu.appendChild(s); continue; }
    const b = document.createElement("button");
    b.textContent = it[0];
    if (it[2]) b.className = "danger";
    b.onclick = () => { closeMenus(); it[1](); };
    menu.appendChild(b);
  }
  anchor.appendChild(menu);
  setTimeout(() => document.addEventListener("click", closeMenus, { once: true }), 0);
}
function closeMenus() { $$(".menu").forEach((m) => m.remove()); }

/* ---------------- Selection / bulk ---------------- */
function toggleSelect(id, on) { on ? state.selection.add(id) : state.selection.delete(id); updateBulkBar(); }
function updateBulkBar() {
  const n = state.selection.size;
  $("#bulkbar").classList.toggle("hidden", n === 0);
  $("#bulk-count").textContent = `${n} selected`;
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

async function moveOrCopy(ids, mode) {
  const v = await promptForm(mode === "move" ? "Move to folder" : "Copy to folder",
    [{ name: "dest", label: "Destination folder ID (tip: use ‘Copy ID’ on a folder, or paste root)", value: state.rootId || "" }],
    mode === "move" ? "Move" : "Copy");
  if (!v || !v.dest) return;
  try {
    await invoke(mode === "move" ? "move_contents" : "copy_contents", { contentIds: ids, destFolderId: v.dest.trim() });
    toast(mode === "move" ? "Moved" : "Copied", "success");
    state.selection.clear();
    await reloadCurrent();
  } catch (e) { toast(String(e), "error", 6000); }
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
    const ids = Array.from(state.selection);
    if (!ids.length) return;
    const m = b.dataset.bulk;
    if (m === "delete") deleteItems(ids);
    else if (m === "move") moveOrCopy(ids, "move");
    else if (m === "copy") moveOrCopy(ids, "copy");
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
