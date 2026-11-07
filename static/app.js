// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const MIN_BOX = 0.01; // ignore accidental clicks smaller than 1% of the frame

let violationTypes = {};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2500);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** Position a .bbox element from a fractional {x,y,w,h}. */
function placeBox(el, box, label) {
  el.style.left = box.x * 100 + "%";
  el.style.top = box.y * 100 + "%";
  el.style.width = box.w * 100 + "%";
  el.style.height = box.h * 100 + "%";
  el.classList.toggle("flip", box.y < 0.08); // keep the label inside the frame
  const lbl = el.querySelector(".bbox-label");
  if (lbl) lbl.textContent = label || "Violation";
  el.hidden = false;
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => showView(tab.dataset.view))
);
function showView(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $("#view-report").hidden = name !== "report";
  $("#view-feed").hidden = name !== "feed";
  if (name === "feed") loadFeed();
}

// ---------- violation types ----------
async function loadTypes() {
  violationTypes = await fetch("/api/violation-types").then((r) => r.json());
  for (const [value, label] of Object.entries(violationTypes)) {
    $("#violation-type").add(new Option(label, value));
    $("#filter-type").add(new Option(label, value));
  }
}

// ---------- upload + bounding-box editor ----------
const state = { file: null, kind: null, box: null, videoTime: null, objectUrl: null };
const stage = $("#stage");
const layer = $("#draw-layer");
const bboxEl = $("#bbox");

$("#media-input").addEventListener("change", (e) => e.target.files[0] && loadFile(e.target.files[0]));

const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
);
dz.addEventListener("drop", (e) => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));

function loadFile(file) {
  const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null;
  if (!kind) return showError("Please choose an image or video file.");
  if (file.size > 50 * 1024 * 1024) return showError("File is too large (max 50 MB).");
  showError("");

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  stage.querySelector("img, video")?.remove();
  Object.assign(state, { file, kind, box: null, videoTime: null, objectUrl: URL.createObjectURL(file) });

  const media = document.createElement(kind === "video" ? "video" : "img");
  media.src = state.objectUrl;
  if (kind === "video") {
    media.controls = true;
    media.playsInline = true;
    media.muted = true;
  }
  stage.prepend(media);

  bboxEl.hidden = true;
  dz.hidden = true;
  $("#editor").hidden = false;
  $("#mark-btn").hidden = kind !== "video";
  setDrawing(kind === "image");
  updateBoxStatus();
}

/** For video, drawing is toggled so the native controls stay usable while scrubbing. */
function setDrawing(on) {
  layer.classList.toggle("off", !on);
  const video = stage.querySelector("video");
  if (video) {
    $("#mark-btn").textContent = on ? "Back to video controls" : "Pause & mark frame";
    $("#editor-hint").textContent = on
      ? `Frame at ${fmtTime(video.currentTime)} — drag to mark the violation.`
      : "Play or scrub to the moment of the violation, then pause & mark.";
  } else {
    $("#editor-hint").textContent = "Drag on the image to mark the violation.";
  }
}

$("#mark-btn").addEventListener("click", () => {
  const video = stage.querySelector("video");
  const turningOn = layer.classList.contains("off");
  if (turningOn) {
    video.pause();
    // A new frame means the old box no longer applies.
    if (state.videoTime !== null && Math.abs(state.videoTime - video.currentTime) > 0.05) clearBox();
    state.videoTime = video.currentTime;
  }
  setDrawing(turningOn);
});

$("#clear-box").addEventListener("click", clearBox);
$("#change-file").addEventListener("click", () => $("#media-input").click());

function clearBox() {
  state.box = null;
  bboxEl.hidden = true;
  updateBoxStatus();
}

function updateBoxStatus() {
  const s = $("#box-status");
  if (!state.box) return (s.textContent = "No box drawn yet.");
  const pct = (n) => Math.round(n * 100) + "%";
  let txt = `Box marked at ${pct(state.box.x)}, ${pct(state.box.y)} · size ${pct(state.box.w)} × ${pct(state.box.h)}`;
  if (state.kind === "video") txt += ` · at ${fmtTime(state.videoTime)}`;
  s.textContent = txt;
}

// Pointer events cover mouse, touch and pen.
let dragStart = null;
function pointFromEvent(e) {
  const r = layer.getBoundingClientRect();
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
}
function boxFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function currentLabel() {
  return violationTypes[$("#violation-type").value] || "Violation";
}
layer.addEventListener("pointerdown", (e) => {
  dragStart = pointFromEvent(e);
  layer.setPointerCapture(e.pointerId);
});
layer.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  placeBox(bboxEl, boxFrom(dragStart, pointFromEvent(e)), currentLabel());
});
layer.addEventListener("pointerup", (e) => {
  if (!dragStart) return;
  const box = boxFrom(dragStart, pointFromEvent(e));
  dragStart = null;
  if (box.w < MIN_BOX || box.h < MIN_BOX) {
    // Too small: treat as a stray click and restore the previous box, if any.
    state.box ? placeBox(bboxEl, state.box, currentLabel()) : (bboxEl.hidden = true);
    return;
  }
  state.box = box;
  if (state.kind === "video") state.videoTime = stage.querySelector("video").currentTime;
  updateBoxStatus();
});
$("#violation-type").addEventListener("change", () => {
  if (state.box) placeBox(bboxEl, state.box, currentLabel());
});

// ---------- geolocation ----------
$("#geo-btn").addEventListener("click", () => {
  const status = $("#geo-status");
  if (!navigator.geolocation) return (status.textContent = "Location isn't available in this browser.");
  status.textContent = "Getting location…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.lat = pos.coords.latitude;
      state.lng = pos.coords.longitude;
      if (!$("#location").value) $("#location").value = `${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}`;
      status.textContent = "Location attached.";
    },
    () => (status.textContent = "Couldn't get your location — type it instead."),
    { timeout: 10000 }
  );
});

// ---------- submit ----------
function showError(msg) {
  $("#form-error").textContent = msg;
}

$("#report-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.file) return showError("Please upload a photo or video.");
  if (!state.box) return showError("Draw a box around where the violation happened.");
  if (!$("#violation-type").value) return showError("Choose a violation type.");
  showError("");

  const fd = new FormData();
  fd.append("media", state.file);
  fd.append("violation_type", $("#violation-type").value);
  fd.append("description", $("#description").value);
  fd.append("location", $("#location").value);
  fd.append("bbox", JSON.stringify(state.box));
  if (state.lat != null) {
    fd.append("latitude", state.lat);
    fd.append("longitude", state.lng);
  }
  if (state.kind === "video") fd.append("video_time", state.videoTime ?? 0);

  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    const res = await fetch("/api/reports", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    resetForm();
    toast("Report submitted — thank you!");
    showView("feed");
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit report";
  }
});

function resetForm() {
  $("#report-form").reset();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  stage.querySelector("img, video")?.remove();
  Object.assign(state, { file: null, kind: null, box: null, videoTime: null, objectUrl: null, lat: null, lng: null });
  bboxEl.hidden = true;
  $("#editor").hidden = true;
  dz.hidden = false;
  $("#geo-status").textContent = "";
  $("#media-input").value = "";
}

// ---------- feed ----------
$("#filter-type").addEventListener("change", loadFeed);

async function loadFeed() {
  const type = $("#filter-type").value;
  const reports = await fetch("/api/reports" + (type ? `?type=${encodeURIComponent(type)}` : "")).then((r) => r.json());
  const feed = $("#feed");
  feed.replaceChildren(...reports.map(renderCard));
  $("#feed-empty").hidden = reports.length > 0;
}

function renderCard(r) {
  const card = document.createElement("article");
  card.className = "card";

  const wrap = document.createElement("div");
  wrap.className = "media-wrap";
  const media = document.createElement(r.media_kind === "video" ? "video" : "img");
  media.src = r.media_url;
  media.loading = "lazy";
  wrap.append(media);

  const box = document.createElement("div");
  box.className = "bbox";
  box.innerHTML = '<span class="bbox-label"></span>';
  wrap.append(box);
  placeBox(box, r.bbox, r.violation_label);

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = r.violation_label;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const when = new Date(r.created_at).toLocaleString();
  meta.textContent = [r.location, when].filter(Boolean).join(" · ");
  body.append(title, meta);

  if (r.description) {
    const d = document.createElement("div");
    d.textContent = r.description;
    body.append(d);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (r.media_kind === "video") {
    // Show the box only around the marked moment; open the video on that frame.
    media.controls = true;
    media.muted = true;
    media.preload = "metadata";
    media.playsInline = true;
    const t = r.video_time || 0;
    media.addEventListener("loadedmetadata", () => (media.currentTime = t), { once: true });
    media.addEventListener("timeupdate", () => box.classList.toggle("dim", Math.abs(media.currentTime - t) > 0.75));
    const jump = document.createElement("button");
    jump.className = "btn";
    jump.textContent = `Jump to violation (${fmtTime(t)})`;
    jump.onclick = () => { media.pause(); media.currentTime = t; };
    actions.append(jump);
  }

  if (r.latitude != null && r.longitude != null) {
    const map = document.createElement("a");
    map.className = "btn";
    map.href = `https://www.openstreetmap.org/?mlat=${r.latitude}&mlon=${r.longitude}#map=18/${r.latitude}/${r.longitude}`;
    map.target = "_blank";
    map.rel = "noopener";
    map.textContent = "View on map";
    actions.append(map);
  }

  const del = document.createElement("button");
  del.className = "btn";
  del.textContent = "Delete";
  del.onclick = async () => {
    if (!confirm("Delete this report?")) return;
    await fetch(`/api/reports/${r.id}`, { method: "DELETE" });
    loadFeed();
  };
  actions.append(del);
  body.append(actions);

  const frame = document.createElement("div");
  frame.className = "media-frame";
  frame.style.borderRadius = "0";
  frame.append(wrap);
  card.append(frame, body);
  return card;
}

loadTypes();
