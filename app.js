// MariaBike admin website: bikes and their 4G data, rides, reports, users, locks and the
// service area, read live from Firestore. Only users with users/{uid}.role == "admin" get in;
// firestore.rules enforce the same. Commands go to iot_commands, which the lock server sends on.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, onSnapshot, query, where, orderBy, limit,
  addDoc, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const LOW_VOLTS = 3.5; // lock battery worth charging
const SILENT_MS = 60 * 60 * 1000; // a lock heartbeats every 4 min; an hour of silence is worth a look
const IDLE_MS = 15 * 60 * 1000;   // a session lasts 15 min; Extend adds 15 more
const ALARM_TEXT = { illegal_movement: "Bike moved", fall: "Bike fell over", dismantle: "Lock tampered" };
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

const $ = (id) => document.getElementById(id);
const bikes = new Map();       // imei -> iot_locks doc
const locks = new Map();       // lockId -> locks doc
const users = new Map();       // uid -> users doc
const alarmsToday = new Map(); // imei -> count
const markers = new Map();
let rides = [];
let reports = [];
let messages = [];             // messages/{id}: notes and offers to riders
let area = null;               // settings/geofence
let stops = [];
let me = null;
let map = null, areaMap = null, areaCircle = null, route = null;
let selected = null;           // imei shown in the bike panel
let editing = null;            // lockId in the lock form, null = new

// ---------------- helpers ----------------

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function button(text, onClick, cls = "small") {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function ago(d) {
  if (!d) return "-";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleString();
}

function dayKey(d) { return d.toISOString().slice(0, 10); }

function toast(text, ok = false) {
  const t = el("div", text, "toast");
  if (ok) t.style.background = "#2e9b46";
  $("toasts").append(t);
  setTimeout(() => t.remove(), 8000);
}

function show(id) {
  for (const s of ["login", "denied", "app"]) $(s).hidden = s !== id;
  $("logout").hidden = id === "login";
}

/** Same Omni user ID as the app (lib/lock/utils/lock_ids.dart, FNV-1a 32-bit). */
function omniUserId(uid) {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function metres(lat1, lng1, lat2, lng2) {
  const r = 6371000, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function lockOfImei(imei) {
  for (const [id, l] of locks) if (l.imei === imei) return { id, ...l };
  return null;
}

/** Profile picture (users/{uid}.photo, a small base64 JPEG from the app) or the first letter. */
function avatar(u, big = false) {
  const a = el("span", null, big ? "avatar big" : "avatar");
  if (u?.photo) {
    const img = el("img");
    img.src = `data:image/jpeg;base64,${u.photo}`;
    img.alt = u.name || "Profile picture";
    a.append(img);
  } else {
    a.textContent = (u?.name || u?.email || "?").trim().charAt(0).toUpperCase();
  }
  return a;
}

function riderName(uid) {
  const u = uid && users.get(uid);
  return u ? (u.name || u.email) : "no rider";
}

function riderOf(imei) { return riderName(lockOfImei(imei)?.assignedTo); }

async function logAction(action, target, details = "") {
  await addDoc(collection(db, "admin_log"), {
    uid: me.uid, email: me.email, action, target: String(target), details: String(details), at: serverTimestamp(),
  }).catch(() => {});
}

async function send(imei, cmd, args, label) {
  try {
    await addDoc(collection(db, "iot_commands"), {
      imei, cmd, args, status: "pending", uid: me.uid, at: serverTimestamp(),
    });
    await logAction(label, imei, `${cmd} ${args.join(",")}`);
    toast(`${label}: sent to ${imei}`, true);
  } catch (e) {
    toast(`${label}: could not send (${e.code || e.message})`);
  }
}

// ---------------- sign in ----------------

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  newSession(); // a fresh sign-in starts a fresh session
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (err) {
    $("loginError").textContent = "Sign-in failed. Check email and password.";
  }
});
$("logout").addEventListener("click", () => {
  endSession();
  signOut(auth);
});

// A session lasts IDLE_MS from sign-in. In its last EXTEND_WINDOW_MS the admin may press Extend
// for another IDLE_MS; otherwise they are signed out, also when the tab was left open, the laptop
// slept or the browser was opened again later. The end time is kept in localStorage, so it
// survives a reload or restart and is the same in every open tab.
const IDLE_KEY = "mb_admin_session_end";
const EXTEND_WINDOW_MS = 5 * 60 * 1000; // Extend works only in the last 5 minutes
let sessionEndMem = 0, warned5 = false, warned1 = false;

function readSessionEnd() {
  let v = 0;
  try { v = Number(localStorage.getItem(IDLE_KEY)) || 0; } catch {}
  return v || sessionEndMem;
}
function newSession() {
  sessionEndMem = Date.now() + IDLE_MS;
  warned5 = warned1 = false;
  try { localStorage.setItem(IDLE_KEY, String(sessionEndMem)); } catch {}
}
function endSession() {
  sessionEndMem = 0;
  try { localStorage.removeItem(IDLE_KEY); } catch {}
}
function idleSignOut() {
  endSession();
  signOut(auth);
  toast("Session ended. Please sign in again.");
}
function sessionLeft() { return readSessionEnd() - Date.now(); }
function checkIdle() {
  if (!me) return;
  const left = sessionLeft();
  if (left <= 0) return idleSignOut();
  if (left <= EXTEND_WINDOW_MS && !warned5) {
    warned5 = true;
    toast("Your session ends in 5 minutes. Press Extend to stay signed in.");
  }
  if (left <= 60 * 1000 && !warned1) {
    warned1 = true;
    toast("Your session ends in 1 minute. Press Extend to stay signed in.");
  }
}
/** Time left in the header; Extend is enabled only in the last 5 minutes. */
function showSessionLeft() {
  $("notifBell").hidden = !me;
  const s = $("session"), x = $("extend");
  s.hidden = x.hidden = !me;
  if (!me) return;
  const left = Math.max(0, sessionLeft());
  const sec = Math.ceil(left / 1000);
  s.textContent = `Session ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const canExtend = left <= EXTEND_WINDOW_MS;
  s.classList.toggle("ending", canExtend);
  x.classList.toggle("ending", canExtend);
  x.disabled = !canExtend;
  x.title = canExtend ? `Add ${IDLE_MS / 60000} minutes` : "Extend works in the last 5 minutes";
}
$("extend").addEventListener("click", () => {
  if (!me || sessionLeft() > EXTEND_WINDOW_MS) return;
  newSession();
  showSessionLeft();
  toast(`Session extended: ${IDLE_MS / 60000} more minutes`, true);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkIdle(); showSessionLeft(); } });
setInterval(checkIdle, 5000);
setInterval(showSessionLeft, 1000);

/** Asks for the admin's password again before dangerous actions. Resolves to true when confirmed. */
function confirmWithPassword(text) {
  const dlg = $("reauth");
  $("reauthText").textContent = text;
  $("reauthPass").value = "";
  $("reauthError").textContent = "";
  dlg.showModal();
  return new Promise((resolve) => {
    $("reauthOk").onclick = async (e) => {
      e.preventDefault();
      try {
        await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(me.email, $("reauthPass").value));
        dlg.close();
        resolve(true);
      } catch {
        $("reauthError").textContent = "Wrong password.";
      }
    };
    dlg.onclose = () => resolve(false);
  });
}

onAuthStateChanged(auth, async (user) => {
  stops.forEach((stop) => stop());
  stops = [];
  if (historyStop) { historyStop(); historyStop = null; }
  clearAlarmAlert();
  alarmFeed.clear();
  closeFeed();
  me = user;
  $("who").textContent = user ? user.email : "";
  if (!user) return show("login");
  // Firebase remembers the sign-in. A reload keeps the running session; one that has ended,
  // or a sign-in remembered from before sessions were timed, means signing in again.
  if (sessionLeft() <= 0) return idleSignOut();
  const profile = await getDoc(doc(db, "users", user.uid)).catch(() => null);
  if (profile?.data()?.role !== "admin") return show("denied");
  show("app");
  start();
});

// ---------------- live data ----------------

function start() {
  if (!map) {
    map = L.map("map").setView([40.52, -8.51], 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }
  const listen = (q, fn) => stops.push(onSnapshot(q, fn, (e) => toast(`Could not load data: ${e.code}`)));

  listen(collection(db, "iot_locks"), (snap) => {
    snap.docs.forEach((d) => {
      if (!bikes.has(d.id)) watchAlarms(d.id);
      bikes.set(d.id, d.data());
    });
    renderBikes();
  });
  listen(collection(db, "locks"), (snap) => {
    locks.clear();
    snap.docs.forEach((d) => locks.set(d.id, d.data()));
    renderBikes(); renderLocks();
  });
  listen(collection(db, "users"), (snap) => {
    users.clear();
    snap.docs.forEach((d) => users.set(d.id, d.data()));
    renderBikes(); renderUsers(); renderLocks(); renderRides(); renderReports(); renderProfile();
    renderMsgTo(); renderMessages();
  });
  listen(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(100)), (snap) => {
    messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMessages();
  });
  listen(query(collection(db, "rides"), orderBy("startAt", "desc"), limit(1000)), (snap) => {
    rides = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRides(); renderStats(); renderProfile();
  });
  listen(collection(db, "reports"), (snap) => {
    reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
    renderReports();
  });
  listen(doc(db, "settings", "geofence"), (snap) => {
    area = snap.exists() ? snap.data() : null;
    renderArea(); renderBikes();
  });
  listen(query(collection(db, "admin_log"), orderBy("at", "desc"), limit(200)), (snap) => {
    renderLog(snap.docs.map((d) => d.data()));
  });
}

// "fall" is off everywhere (the lock reports it wrongly); it stays only in the bike's event list
const isAlert = (e) => e.event === "alarm" && e.alarm !== "fall" && !String(e.alarm || "").endsWith("_cleared");

/** Counts today's alarms of one bike and pops up a message for new ones. */
function watchAlarms(imei) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const q = query(collection(db, "iot_locks", imei, "events"), where("at", ">=", Timestamp.fromDate(midnight)));
  let first = true;
  stops.push(onSnapshot(q, (snap) => {
    alarmsToday.set(imei, snap.docs.filter((d) => isAlert(d.data())).length);
    for (const [id, f] of alarmFeed) if (f.imei === imei) alarmFeed.delete(id);
    snap.docs.forEach((d) => {
      const e = d.data();
      if (isAlert(e)) alarmFeed.set(d.id, { imei, alarm: e.alarm, at: toDate(e.at) || new Date() });
    });
    renderFeed();
    if (!first) {
      snap.docChanges().forEach((c) => {
        if (c.type === "added" && isAlert(c.doc.data())) alarmAlert(imei, c.doc.data().alarm);
      });
    }
    first = false;
    renderTiles();
  }));
}

// ---------------- alarm alert: banner, sound, tab title, desktop notification ----------------

const SOUND_KEY = "mb_admin_alarm_sound";
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } })();
let audioCtx = null, alarmImei = null, titleTimer = null, lastSound = 0;
const baseTitle = document.title;

// ---- notification center: the bell lists today's alarms of all bikes ----
const SEEN_KEY = "mb_admin_alarms_seen";
const alarmFeed = new Map(); // event id -> { imei, alarm, at }
const ALARM_ICON = { illegal_movement: "🚲", fall: "⚠️", dismantle: "🔧" };
let seenAt = (() => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } })();

function renderFeed() {
  const items = [...alarmFeed.values()].sort((a, b) => b.at - a.at);
  const unread = items.filter((f) => f.at.getTime() > seenAt).length;
  $("notifCount").hidden = unread === 0;
  $("notifCount").textContent = unread > 99 ? "99+" : String(unread);
  $("notifBell").title = unread ? `${unread} new alarm${unread === 1 ? "" : "s"}` : "Alarms";
  const counts = {};
  items.forEach((f) => { counts[f.alarm] = (counts[f.alarm] || 0) + 1; });
  $("notifSummary").textContent = Object.entries(counts)
    .map(([k, n]) => `${n} × ${(ALARM_TEXT[k] || k).toLowerCase()}`).join(" · ");
  const list = $("notifList");
  list.replaceChildren();
  if (!items.length) return list.append(el("li", "No alarms today.", "muted empty"));
  items.slice(0, 100).forEach((f) => {
    const li = el("li", null, f.at.getTime() > seenAt ? "unread" : "");
    li.tabIndex = 0;
    const lock = lockOfImei(f.imei);
    li.append(
      el("span", ALARM_ICON[f.alarm] || "🚨", "ic"),
      el("span", ALARM_TEXT[f.alarm] || f.alarm, "what"),
      el("span", `${riderOf(f.imei)} · ${lock ? `Lock ${lock.id}` : f.imei}`, "who2"),
      el("time", `${f.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${ago(f.at)}`),
    );
    const open = () => { closeFeed(); openBike(f.imei); };
    li.onclick = open;
    li.onkeydown = (e) => { if (e.key === "Enter") open(); };
    list.append(li);
  });
}
function openFeed() {
  renderFeed(); // the new ones stay highlighted while the list is open
  $("notifPanel").hidden = false;
  $("notifBell").setAttribute("aria-expanded", "true");
  seenAt = Date.now();
  try { localStorage.setItem(SEEN_KEY, String(seenAt)); } catch {}
  $("notifCount").hidden = true;
  clearAlarmAlert();
}
function closeFeed() {
  if ($("notifPanel").hidden) return;
  $("notifPanel").hidden = true;
  $("notifBell").setAttribute("aria-expanded", "false");
  renderFeed();
}
$("notifBell").onclick = (e) => { e.stopPropagation(); if ($("notifPanel").hidden) openFeed(); else closeFeed(); };
$("notifPanel").onclick = (e) => e.stopPropagation();
document.addEventListener("click", closeFeed);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFeed(); });
setInterval(() => { if (me && !$("notifPanel").hidden) renderFeed(); }, 60000); // "5 min ago" moves on

function showSoundState() {
  $("notifBell").hidden = !me;
  const blocked = soundOn && (!audioCtx || audioCtx.state !== "running");
  $("soundToggle").textContent = `Alarm sound: ${soundOn ? "on" : "off"}`;
  $("soundNote").textContent = blocked ? "Click anywhere on the page to allow sound." : "";
  $("notifBell").classList.toggle("warn", blocked);
}
showSoundState();
$("soundToggle").onclick = () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch {}
  showSoundState();
};
// Browsers only play sound (and ask about desktop notifications) after the page was clicked
// or a key pressed. Every click or key press (re)starts the audio until it runs.
let askedNotify = false;
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state !== "running") audioCtx.resume().then(showSoundState, () => {});
  }
  // desktop notifications for alarms while the tab is in the background: asked once, after sign-in
  if (me && !askedNotify && "Notification" in window && Notification.permission === "default") {
    askedNotify = true;
    Notification.requestPermission().catch(() => {});
  }
  showSoundState();
}
["pointerdown", "keydown", "touchstart"].forEach((e) =>
  document.addEventListener(e, unlockAudio, { capture: true, passive: true }));

/** Three short tones, made in the browser (no sound file). */
function beepSound() {
  if (!audioCtx || !soundOn) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const t0 = audioCtx.currentTime;
  [0, 0.3, 0.6].forEach((dt, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = i === 1 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.15, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.25);
  });
}

function alarmAlert(imei, kind) {
  const text = `${ALARM_TEXT[kind] || "Alarm"}: ${riderOf(imei)} (${imei})`;
  toast(text);
  alarmImei = imei;
  $("alarmBannerText").textContent = `🚨 ${text} · ${new Date().toLocaleTimeString()}`;
  $("alarmBanner").hidden = false;
  // a moved bike sends several alarms in a row; one sound every 20 s is enough
  if (soundOn && Date.now() - lastSound > 20000) {
    lastSound = Date.now();
    if (!audioCtx || audioCtx.state !== "running") toast("Alarm sound is blocked by the browser: click anywhere on the page once.");
    beepSound();
  }
  if (!titleTimer) {
    let on = false;
    titleTimer = setInterval(() => { on = !on; document.title = on ? "🚨 ALARM" : baseTitle; }, 1000);
  }
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try { new Notification("MariaBike alarm", { body: text, tag: `alarm-${imei}` }); } catch {}
  }
}
function clearAlarmAlert() {
  $("alarmBanner").hidden = true;
  clearInterval(titleTimer);
  titleTimer = null;
  document.title = baseTitle;
}
$("alarmDismiss").onclick = clearAlarmAlert;
$("alarmOpen").onclick = () => { const i = alarmImei; clearAlarmAlert(); if (i) openBike(i); };

// ---------------- bikes ----------------

function silent(b) {
  const t = toDate(b.updated_at);
  return !t || Date.now() - t.getTime() > SILENT_MS;
}

function matchesFilter(imei, b) {
  const f = $("bikeFilter").value;
  if (f === "online" && !b.online) return false;
  if (f === "offline" && b.online) return false;
  if (f === "silent" && !silent(b)) return false;
  if (f === "low" && !(b.lock_voltage < LOW_VOLTS)) return false;
  if (f === "outside" && !outside(b)) return false;
  const s = $("bikeSearch").value.trim().toLowerCase();
  if (!s) return true;
  const lock = lockOfImei(imei);
  const u = users.get(lock?.assignedTo) || {};
  return [imei, lock?.id, u.name, u.email].some((x) => String(x || "").toLowerCase().includes(s));
}

$("bikeSearch").addEventListener("input", () => renderBikes());
$("bikeFilter").addEventListener("change", () => renderBikes());

function outside(b) {
  if (!area?.enabled || !b.position || b.position.lat == null) return false;
  return metres(area.lat, area.lng, b.position.lat, b.position.lng) > area.radiusM;
}

function renderTiles() {
  const list = [...bikes.values()];
  $("tBikes").textContent = list.length;
  $("tOnline").textContent = list.filter((b) => b.online).length;
  $("tLow").textContent = list.filter((b) => b.lock_voltage != null && b.lock_voltage < LOW_VOLTS).length;
  $("tAlarms").textContent = [...alarmsToday.values()].reduce((a, b) => a + b, 0);
  $("tOpen").textContent = reports.filter((r) => r.status !== "resolved").length;
  $("tSilent").textContent = list.filter(silent).length;
}

// "No contact" changes with time, not only with new data
setInterval(() => { if (me && bikes.size) renderBikes(); }, 60000);

function renderBikes() {
  renderTiles();
  const rows = $("bikeRows");
  rows.replaceChildren();
  $("noBikes").hidden = bikes.size > 0;
  // Bikes that need charging first
  const list = [...bikes.entries()].sort((a, b) => (a[1].lock_voltage ?? 9) - (b[1].lock_voltage ?? 9));
  for (const [imei, b] of list) {
    placeMarker(imei, b);
    if (!matchesFilter(imei, b)) continue;
    const tr = el("tr", null, silent(b) ? "clickable silent" : "clickable");
    const lock = lockOfImei(imei);
    tr.append(el("td", lock ? `Lock ${lock.id}` : imei));
    tr.append(el("td", riderOf(imei)));
    const status = el("td");
    status.append(el("span", null, `dot ${b.online ? "on" : "off"}`), b.online ? "Online" : "Offline");
    tr.append(status);
    tr.append(el("td", b.locked == null ? "-" : b.locked ? "Locked" : "Unlocked"));
    tr.append(el("td", b.lock_voltage == null ? "-" : `${b.lock_voltage.toFixed(2)} V`,
      b.lock_voltage < LOW_VOLTS ? "low" : ""));
    tr.append(el("td", b.signal == null ? "-" : String(b.signal)));
    tr.append(el("td", !area?.enabled ? "-" : outside(b) ? "Outside" : "Inside", outside(b) ? "out" : ""));
    tr.append(el("td", b.position ? ago(toDate(b.position.at)) : "never"));
    tr.append(el("td", ago(toDate(b.updated_at))));
    const actions = el("td");
    actions.append(button("Open", (e) => { e.stopPropagation(); openBike(imei); }));
    tr.append(actions);
    tr.onclick = () => openBike(imei);
    rows.append(tr);
  }
  if (selected) {
    $("bikeTitle").textContent = bikeTitle(selected);
    renderLive(selected);
  }
}

// What the lock last reported (S5 lock info, S6 e-bike info), updated live
function renderLive(imei) {
  const b = bikes.get(imei) || {};
  const num = (v, unit, digits = 0) => (v == null || Number.isNaN(Number(v)) ? "-" : `${Number(v).toFixed(digits)}${unit}`);
  const items = [
    ["Speed", num(b.speed_kmh, " km/h")],
    ["E-bike battery", num(b.bike_battery, " %")],
    ["Lock battery", num(b.lock_voltage, " V", 2)],
    ["Signal", b.signal == null ? "-" : `${b.signal} / 31`],
    ["Lock", b.locked == null ? "-" : b.locked ? "Locked" : "Unlocked"],
    ["Charging", b.charging == null ? "-" : b.charging ? "Yes" : "No"],
    ["Mode", b.bike_mode == null ? "-" : String(b.bike_mode)],
    ["Trip", num(b.trip_km, " km", 2)],
    ["Range left", num(b.remaining_km, " km", 1)],
    ["Total", num(b.total_km, " km", 1)],
    ["Satellites", b.satellites == null ? "-" : String(b.satellites)],
    ["Fault code", b.fault == null || b.fault === "0" ? "none" : String(b.fault)],
  ];
  $("bikeLive").replaceChildren(...items.map(([label, value]) => {
    const t = el("div", null, "tile");
    t.append(el("span", value), el("small", label));
    return t;
  }));
  $("bikeLiveNote").textContent = (b.bike_battery === 0 && !b.total_km
    ? "E-bike values are 0: the lock is probably not connected to the e-bike cable. "
    : "") + `Last update ${ago(toDate(b.updated_at))}.`;
}

function bikeTitle(imei) {
  const b = bikes.get(imei) || {};
  return `${riderOf(imei)} · ${imei} · ${b.online ? "online" : "offline"}`;
}

function placeMarker(imei, b) {
  const p = b.position;
  if (!p || p.lat == null) return;
  const color = b.online ? "#2e9b46" : "#d33a2c";
  let m = markers.get(imei);
  if (!m) {
    m = L.circleMarker([p.lat, p.lng], { radius: 9, weight: 2, color: "#1e1e1e", fillOpacity: .9 }).addTo(map);
    m.on("click", () => openBike(imei));
    markers.set(imei, m);
    if (markers.size === 1) map.setView([p.lat, p.lng], 16);
  }
  m.setLatLng([p.lat, p.lng]).setStyle({ fillColor: color });
  m.bindTooltip(`${riderOf(imei)} · ${ago(toDate(p.at))}`);
}

function openBike(imei) {
  selected = imei;
  $("bike").hidden = false;
  $("bikeTitle").textContent = bikeTitle(imei);
  $("routeDay").value = dayKey(new Date());
  renderLive(imei);
  loadHistory(imei);
  $("histDay").value = dayKey(new Date());
  loadDataHistory(imei);
  $("bike").scrollIntoView({ behavior: "smooth" });
}

$("bikeClose").onclick = () => {
  selected = null;
  if (historyStop) { historyStop(); historyStop = null; }
  $("bike").hidden = true;
  if (route) { route.remove(); route = null; }
};

document.querySelectorAll("#bike [data-cmd]").forEach((b) => b.addEventListener("click", () => bikeCommand(b.dataset.cmd)));

async function bikeCommand(cmd) {
  const imei = selected;
  if (!imei) return;
  const online = bikes.get(imei)?.online;
  if (cmd !== "route" && !online) return toast("The bike is offline. Commands reach it when it reconnects to the server.");
  switch (cmd) {
    case "locate": return send(imei, "D0", [], "Locate");
    case "beep": return send(imei, "S8", [3, 0], "Beep");
    case "trackOn": return send(imei, "D1", [Number($("trackEvery").value)], "Tracking on");
    case "trackOff": return send(imei, "D1", [0], "Tracking off");
    case "alarm": {
      const n = Math.round(Number($("alarmCount").value));
      if (!(n >= 1 && n <= 20)) return toast("Enter a number from 1 to 20");
      // S7: only the 2nd value (alarm after N movements); 0 = leave unchanged
      return send(imei, "S7", [0, n, 0, 0, 0, 0, 0], "Alarm sensitivity");
    }
    case "speed": {
      const mode = Number($("speedMode").value);
      // S4: only the 1st value (speed mode); 0 = leave unchanged
      return send(imei, "S4", [mode, 0, 0, 0, 0, 0, 0, 0, 0], "Speed mode");
    }
    case "route": return showRoute(imei, $("routeDay").value);
    case "unlock": {
      const typed = prompt(`Remote unlock opens the lock of ${riderOf(imei)}.\nType the IMEI to confirm:\n${imei}`);
      if (typed == null) return;
      if (typed.trim() !== imei) return toast("IMEI did not match. Nothing was sent.");
      if (!(await confirmWithPassword(`Remote unlock of ${riderOf(imei)} (${imei}).`))) return;
      return send(imei, "L0", [0, omniUserId(me.uid), Math.floor(Date.now() / 1000)], "Remote unlock");
    }
  }
}

/** The open bike's last 50 events, updated live while the panel is open. */
let historyStop = null;
function loadHistory(imei) {
  if (historyStop) { historyStop(); historyStop = null; }
  const list = $("historyList");
  list.replaceChildren(el("li", "Loading...", "muted"));
  const q = query(collection(db, "iot_locks", imei, "events"), orderBy("at", "desc"), limit(50));
  historyStop = onSnapshot(q, (snap) => {
    if (selected !== imei) return;
    list.replaceChildren();
    if (snap.empty) return list.append(el("li", "No events yet.", "muted"));
    snap.docs.forEach((d) => {
      const e = d.data();
      list.append(el("li", `${toDate(e.at)?.toLocaleString() ?? ""} · ${eventText(e)}`, e.event === "alarm" ? "alarm" : ""));
    });
  }, (e) => list.replaceChildren(el("li", `Could not load events: ${e.code}`, "muted")));
}

// ---------------- data history (iot_locks/{imei}/history/{YYYY-MM-DD}) ----------------

const HIST_METRICS = [
  { key: "bike_battery", title: "E-bike battery", unit: "%", zero: true, max: 100 },
  { key: "speed_kmh", title: "Speed", unit: "km/h", zero: true },
  { key: "lock_voltage", title: "Lock battery", unit: "V", decimals: 2 },
  { key: "signal", title: "4G signal", unit: "of 31", zero: true, max: 31 },
  { key: "satellites", title: "GPS satellites", unit: "", zero: true },
  { key: "total_km", title: "Total distance", unit: "km", decimals: 1 },
  { key: "remaining_km", title: "Range left", unit: "km", zero: true, decimals: 1 },
  { key: "trip_km", title: "Trip", unit: "km", zero: true, decimals: 2 },
];
let histSamples = [];  // samples of the bike panel, oldest first
let histRange = null;  // [start ms, end ms]

function histDaysList(endDay, n) {
  const end = new Date(`${endDay}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => dayKey(new Date(end.getTime() - (n - 1 - i) * 86400000)));
}

async function loadDataHistory(imei) {
  const endDay = $("histDay").value || dayKey(new Date());
  const days = histDaysList(endDay, Number($("histDays").value));
  $("histNote").textContent = "Loading...";
  $("histCharts").replaceChildren();
  let denied = false;
  const snaps = await Promise.all(days.map((d) => getDoc(doc(db, "iot_locks", imei, "history", d)).catch((e) => {
    if (e.code === "permission-denied") denied = true;
    return null;
  })));
  if (selected !== imei) return; // another bike was opened meanwhile
  if (denied) {
    histSamples = [];
    $("histCharts").replaceChildren();
    $("histNote").textContent = "No permission to read the data history: publish the latest firestore.rules in the Firebase console.";
    return;
  }
  histSamples = snaps.flatMap((s) => (s?.exists() ? s.data().samples || [] : [])).sort((a, b) => a.t - b.t);
  histRange = [new Date(`${days[0]}T00:00:00Z`).getTime(), new Date(`${endDay}T00:00:00Z`).getTime() + 86400000];
  renderDataHistory();
}

function renderDataHistory() {
  const box = $("histCharts");
  box.replaceChildren();
  if (!histSamples.length) {
    $("histNote").textContent = "No data saved for these days. The server saves the data every 30 minutes while the bike is online.";
    return;
  }
  const first = new Date(histSamples[0].t * 1000), last = new Date(histSamples.at(-1).t * 1000);
  $("histNote").textContent = `${histSamples.length} readings, ${first.toLocaleString()} to ${last.toLocaleString()}. Times in your time zone.`;
  // All boxes first, so each chart measures its final grid width
  const boxes = HIST_METRICS.map(() => box.appendChild(el("div", null, "chart")));
  HIST_METRICS.forEach((m, i) => {
    const pts = histSamples.filter((s) => typeof s[m.key] === "number").map((s) => ({ t: s.t * 1000, v: s[m.key] }));
    lineChart(boxes[i], pts, { ...m, range: histRange });
  });
}

function timeLabel(ms, spanDays) {
  const d = new Date(ms);
  return spanDays <= 1 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

/** One measure over time: a 2px line, broken where the bike sent nothing for 20 min, with a hover crosshair. */
function lineChart(box, pts, { title, unit, decimals = 0, zero = false, max = null, range }) {
  box.append(el("h4", unit ? `${title} (${unit})` : title));
  if (!pts.length) { box.append(el("div", "No readings.", "empty")); return; }
  const W = Math.max(260, box.clientWidth || 360), H = 170, L = 40, R = 10, T = 10, B = 24;
  const [t0, t1] = range;
  const vals = pts.map((p) => p.v);
  let lo = zero ? 0 : Math.min(...vals), hi = max ?? Math.max(...vals);
  if (!zero) { const pad = (hi - lo) * 0.1 || Math.max(0.05, Math.abs(hi) * 0.02); lo -= pad; hi += pad; }
  if (zero && max == null) hi = niceMax(hi);
  if (hi === lo) hi = lo + 1;
  const x = (t) => L + ((W - L - R) * (t - t0)) / (t1 - t0);
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title} over time` });
  [lo, (lo + hi) / 2, hi].forEach((v) => {
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" }));
    svg.append(svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis-text" }, fmt(v, decimals)));
  });
  const spanDays = (t1 - t0) / 86400000;
  const ticks = spanDays <= 1 ? 4 : Math.min(spanDays, 6);
  for (let i = 0; i < ticks; i++) { // the end of the range is the start of the next day: not labelled
    const t = t0 + ((t1 - t0) * i) / ticks;
    svg.append(svgEl("text", { x: x(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle", class: "axis-text" },
      timeLabel(t, spanDays)));
  }
  let d = "";
  pts.forEach((p, i) => {
    const gap = i === 0 || p.t - pts[i - 1].t > 20 * 60000;
    d += `${gap ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
  });
  svg.append(svgEl("path", { d, class: "line" }));
  if (pts.length === 1) svg.append(svgEl("circle", { cx: x(pts[0].t), cy: y(pts[0].v), r: 4, class: "dot" }));
  const cross = svgEl("line", { y1: T, y2: H - B, class: "crosshair", visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, class: "dot ring", visibility: "hidden" });
  const hit = svgEl("rect", { x: L, y: T, width: W - L - R, height: H - T - B, class: "hit" });
  svg.append(cross, dot, hit);
  const hide = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); box.querySelectorAll(".tip").forEach((t) => t.remove()); };
  hit.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect(), s = r.width / W;
    const t = t0 + ((ev.clientX - r.left) / s - L) / (W - L - R) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = x(best.t), py = y(best.v);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    box.querySelectorAll(".tip").forEach((old) => old.remove());
    const tip = el("div", `${new Date(best.t).toLocaleString()}: ${fmt(best.v, decimals)} ${unit}`, "tip");
    tip.style.left = `${px * s}px`; tip.style.top = `${svg.offsetTop + py * s}px`;
    box.append(tip);
  });
  hit.addEventListener("mouseleave", hide);
  box.append(svg);
  // Table view, built only when opened (30 days can be thousands of readings)
  const det = el("details");
  det.append(el("summary", "Show as table"));
  det.addEventListener("toggle", () => {
    if (!det.open || det.querySelector("table")) return;
    const tbl = el("table");
    const head = el("tr");
    head.append(el("th", "Time"), el("th", unit || title));
    tbl.append(head);
    pts.forEach((p) => { const tr = el("tr"); tr.append(el("td", new Date(p.t).toLocaleString()), el("td", fmt(p.v, decimals))); tbl.append(tr); });
    det.append(tbl);
  }, { once: false });
  box.append(det);
}

["histDay", "histDays"].forEach((id) => $(id).addEventListener("change", () => selected && loadDataHistory(selected)));

/** Saves text as a file; the link is in the page while clicked and freed later (Firefox and Safari need both). */
function saveFile(name, text, type = "text/csv") {
  const a = el("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type }));
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$("histCsv").onclick = () => {
  if (!histSamples.length) return toast($("histNote").textContent || "No data to download for these days.");
  const cols = ["time", ...HIST_METRICS.map((m) => m.key), "locked", "charging", "bike_mode", "fault", "lat", "lng"];
  const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [cols.join(",")];
  histSamples.forEach((s) => lines.push(cols.map((c) => cell(c === "time" ? new Date(s.t * 1000).toISOString() : s[c])).join(",")));
  saveFile(`mariabike-${selected}-${$("histDay").value || dayKey(new Date())}-${$("histDays").value}d.csv`, lines.join("\n"));
  toast(`Downloaded ${histSamples.length} readings.`, true);
};

function eventText(e) {
  switch (e.event) {
    case "alarm": return ALARM_TEXT[e.alarm] || `Alarm ${e.alarm}`;
    case "position": {
      const p = e.position || {};
      return p.valid ? `Position ${p.lat}, ${p.lng} (${p.satellites} satellites)` : "Position not available";
    }
    case "locked": return `Locked after ${e.ride_minutes} min`;
    case "unlocked": return "Unlocked";
    case "unlock_failed": return "Unlock failed";
    case "sign_in": return `Connected, lock battery ${e.lock_voltage} V`;
    default: return e.event;
  }
}

async function showRoute(imei, day) {
  if (!day) return toast("Choose a day");
  const from = new Date(`${day}T00:00:00`), to = new Date(from.getTime() + 86400000);
  const q = query(collection(db, "iot_locks", imei, "events"),
    where("at", ">=", Timestamp.fromDate(from)), where("at", "<", Timestamp.fromDate(to)), orderBy("at"), limit(2000));
  const snap = await getDocs(q).catch((e) => { toast(`Could not load the route: ${e.code}`); return null; });
  if (!snap) return;
  const points = snap.docs.map((d) => d.data()).filter((e) => e.event === "position" && e.position?.valid)
    .map((e) => [e.position.lat, e.position.lng]);
  if (route) route.remove();
  route = null;
  if (points.length === 0) return toast("No GPS positions on that day");
  route = L.polyline(points, { color: "#1e1e1e", weight: 4 }).addTo(map);
  map.fitBounds(route.getBounds(), { maxZoom: 17 });
  $("map").scrollIntoView({ behavior: "smooth" });
  toast(`${points.length} positions on ${day}`, true);
}

// ---------------- rides ----------------

function ridesInRange() {
  const from = $("ridesFrom").value ? new Date(`${$("ridesFrom").value}T00:00:00`) : null;
  const to = $("ridesTo").value ? new Date(new Date(`${$("ridesTo").value}T00:00:00`).getTime() + 86400000) : null;
  const onlyActive = $("ridesActive").checked;
  return rides.filter((r) => {
    const s = toDate(r.startAt);
    return s && (!from || s >= from) && (!to || s < to) && (!onlyActive || r.status === "active");
  });
}

$("ridesActive").addEventListener("change", renderRides);

/** A ride stays "active" when the phone never saw the lock close; the admin can end it. */
async function endRide(r) {
  const start = toDate(r.startAt);
  const minutes = start ? Math.max(0, Math.round((Date.now() - start.getTime()) / 60000)) : 0;
  if (!confirm(`End the ride of ${riderName(r.uid)} that started ${start?.toLocaleString()}? It will count ${minutes} minutes.`)) return;
  await updateDoc(doc(db, "rides", r.id), {
    status: "done", endAt: serverTimestamp(), minutes, endedBy: "admin",
  }).then(() => logAction("Ride ended", r.id, `${minutes} min`))
    .catch((e) => toast(`Could not end the ride: ${e.code}`));
}

function rideKm(r) { return (r.distanceKm || 0) || (r.bikeKm || 0); }

function renderRides() {
  const list = ridesInRange();
  const rows = $("rideRows");
  rows.replaceChildren();
  list.slice(0, 300).forEach((r) => {
    const tr = el("tr");
    tr.append(el("td", toDate(r.startAt)?.toLocaleString() ?? "-"), el("td", riderName(r.uid)),
      el("td", r.lockId || "-"), el("td", r.minutes ?? "-"), el("td", rideKm(r).toFixed(2)),
      el("td", r.co2SavedKg != null ? `${r.co2SavedKg.toFixed(2)} kg` : "-"), el("td", r.replaced || "-"),
      el("td", r.status || "-"));
    const actions = el("td");
    if (r.status === "active") actions.append(button("End ride", () => endRide(r)));
    tr.append(actions);
    rows.append(tr);
  });
  const km = list.reduce((a, r) => a + rideKm(r), 0);
  const co2 = list.reduce((a, r) => a + (r.co2SavedKg || 0), 0);
  $("ridesSum").textContent = `${list.length} rides · ${km.toFixed(1)} km · ${co2.toFixed(1)} kg CO₂ saved`
    + (list.length > 300 ? " · the table shows the newest 300, the CSV has all" : "");
}

["ridesFrom", "ridesTo"].forEach((id) => $(id).addEventListener("change", renderRides));

$("ridesCsv").onclick = () => {
  const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [["start", "end", "rider", "email", "lock", "minutes", "km", "co2_saved_kg", "replaced", "status", "ended_by"].join(",")];
  ridesInRange().forEach((r) => {
    const u = users.get(r.uid) || {};
    lines.push([toDate(r.startAt)?.toISOString(), toDate(r.endAt)?.toISOString(), u.name, u.email, r.lockId,
      r.minutes, rideKm(r).toFixed(3), r.co2SavedKg, r.replaced, r.status, r.endedBy].map(cell).join(","));
  });
  saveFile(`mariabike-rides-${dayKey(new Date())}.csv`, lines.join("\n"));
};

// ---------------- stats ----------------

function renderStats() {
  const since = Date.now() - 30 * 86400000;
  const recent = rides.filter((r) => (toDate(r.startAt)?.getTime() || 0) >= since);
  $("sRides").textContent = recent.length;
  $("sKm").textContent = recent.reduce((a, r) => a + rideKm(r), 0).toFixed(1);
  $("sCo2").textContent = recent.reduce((a, r) => a + (r.co2SavedKg || 0), 0).toFixed(1);
  $("sRiders").textContent = new Set(recent.map((r) => r.uid).filter(Boolean)).size;

  renderDaily();

  const replaced = {};
  recent.forEach((r) => { if (r.replaced) replaced[r.replaced] = (replaced[r.replaced] || 0) + 1; });
  const names = { car: "Car", motorbike: "Motorbike", bus: "Bus", train: "Train", walk: "Walking", none: "Nothing (extra trip)" };
  barChart($("replacedChart"), Object.entries(replaced).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: names[k] || k, value: v })), { unit: "rides", empty: "No answers yet (last 30 days)." });

  const buckets = [["0-10 min", 0, 10], ["10-20", 10, 20], ["20-30", 20, 30], ["30-60", 30, 60], ["60+ min", 60, Infinity]];
  const done = recent.filter((r) => r.minutes != null);
  columnChart($("lengthChart"), buckets.map(([label, lo, hi]) => ({
    label, value: done.filter((r) => r.minutes >= lo && r.minutes < hi).length,
  })), { unit: "rides", empty: "No finished rides yet (last 30 days)." });
}

function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 86400000)));
  return days;
}

function renderDaily() {
  const metric = $("dailyMetric").value, n = Number($("dailyDays").value);
  const days = lastDays(n);
  const sums = Object.fromEntries(days.map((d) => [d, 0]));
  rides.forEach((r) => {
    const s = toDate(r.startAt);
    if (!s || sums[dayKey(s)] == null) return;
    sums[dayKey(s)] += metric === "rides" ? 1 : metric === "km" ? rideKm(r) : (r.co2SavedKg || 0);
  });
  const unit = { rides: "rides", km: "km", co2: "kg CO₂" }[metric];
  $("dailyTitle").textContent = { rides: "Rides per day", km: "km per day", co2: "CO₂ saved per day" }[metric];
  columnChart($("dailyChart"), days.map((d) => ({ label: d.slice(5), full: d, value: sums[d] })),
    { unit, decimals: metric === "rides" ? 0 : 1, everyNthLabel: n > 14 ? 5 : 2 });
}

$("dailyMetric").addEventListener("change", renderDaily);
$("dailyDays").addEventListener("change", renderDaily);

/** Alarms of every bike in the last 30 days (read when the Stats tab opens). */
async function renderAlarmChart() {
  const days = lastDays(30);
  const counts = Object.fromEntries(days.map((d) => [d, 0]));
  const since = Timestamp.fromDate(new Date(`${days[0]}T00:00:00`));
  for (const imei of bikes.keys()) {
    const snap = await getDocs(query(collection(db, "iot_locks", imei, "events"),
      where("at", ">=", since), orderBy("at"), limit(5000))).catch(() => null);
    snap?.docs.forEach((d) => {
      const e = d.data();
      const at = toDate(e.at);
      if (e.event === "alarm" && at && counts[dayKey(at)] != null) counts[dayKey(at)]++;
    });
  }
  columnChart($("alarmChart"), days.map((d) => ({ label: d.slice(5), full: d, value: counts[d] })),
    { unit: "alarms", everyNthLabel: 5 });
}

// ---------------- charts (plain SVG) ----------------

const SVG = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function fmt(v, decimals = 0) {
  return v.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

/** Columns with a 4px rounded top on a square baseline; a column path, not a rect, so only the data end rounds. */
function columnPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function tableView(data, unit, decimals) {
  const d = el("details");
  d.append(el("summary", "Show as table"));
  const t = el("table");
  const head = el("tr");
  head.append(el("th", "Period"), el("th", unit));
  t.append(head);
  data.forEach((p) => { const tr = el("tr"); tr.append(el("td", p.full || p.label), el("td", fmt(p.value, decimals))); t.append(tr); });
  d.append(t);
  return d;
}


function columnChart(box, data, { unit, decimals = 0, everyNthLabel = 1, empty = "No data yet." } = {}) {
  box.replaceChildren();
  if (!data.length || data.every((p) => !p.value)) { box.append(el("div", empty, "empty")); return; }
  const W = Math.max(280, box.clientWidth || 720), H = 220, L = 36, R = 8, T = 18, B = 26;
  const max = niceMax(Math.max(...data.map((p) => p.value)));
  const slot = (W - L - R) / data.length, bw = Math.min(24, slot * 0.7);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${unit} chart` });
  [0, 0.5, 1].forEach((f) => {
    const v = max * f;
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" }));
    svg.append(svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis-text" }, fmt(v, decimals && v < 10 ? 1 : 0)));
  });
  const peak = data.reduce((a, p, i) => (p.value > data[a].value ? i : a), 0);
  data.forEach((p, i) => {
    const cx = L + slot * i + slot / 2;
    const hit = svgEl("rect", { x: L + slot * i, y: T, width: slot, height: H - T - B, class: "hit" });
    const h = Math.max(0, y(0) - y(p.value));
    svg.append(hit, svgEl("path", { d: columnPath(cx - bw / 2, y(p.value), bw, h), class: "mark" }));
    if (i === peak && p.value > 0) {
      svg.append(svgEl("text", { x: cx, y: y(p.value) - 5, "text-anchor": "middle", class: "value-text" }, fmt(p.value, decimals)));
    }
    if (i % everyNthLabel === 0 || i === data.length - 1) {
      svg.append(svgEl("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "axis-text" }, p.label));
    }
    // tooltip position in CSS pixels, from the SVG's scale when it is drawn
    hit.addEventListener("mouseenter", () => {
      const s = svg.getBoundingClientRect().width / W;
      box.querySelectorAll(".tip").forEach((t) => t.remove());
      const tip = el("div", `${p.full || p.label}: ${fmt(p.value, decimals)} ${unit}`, "tip");
      tip.style.left = `${cx * s}px`; tip.style.top = `${y(p.value) * s}px`;
      box.append(tip);
    });
    hit.addEventListener("mouseleave", () => box.querySelectorAll(".tip").forEach((t) => t.remove()));
  });
  box.append(svg, tableView(data, unit, decimals));
}

/** Horizontal bars, sorted, value at the tip. */
function barChart(box, data, { unit, empty = "No data yet." } = {}) {
  box.replaceChildren();
  if (!data.length) { box.append(el("div", empty, "empty")); return; }
  const W = Math.max(260, box.clientWidth || 360), rowH = 30, L = 130, R = 40, H = data.length * rowH + 8;
  const max = Math.max(...data.map((p) => p.value));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${unit} chart` });
  data.forEach((p, i) => {
    const yy = 4 + i * rowH, bh = 16, w = ((W - L - R) * p.value) / max;
    const r = Math.min(4, bh / 2, w);
    svg.append(svgEl("text", { x: L - 8, y: yy + 13, "text-anchor": "end", class: "axis-text" }, p.label));
    svg.append(svgEl("path", {
      d: `M${L},${yy}H${L + w - r}Q${L + w},${yy} ${L + w},${yy + r}V${yy + bh - r}Q${L + w},${yy + bh} ${L + w - r},${yy + bh}H${L}Z`,
      class: "mark",
    }));
    svg.append(svgEl("text", { x: L + w + 6, y: yy + 13, class: "value-text" }, fmt(p.value)));
  });
  box.append(svg, tableView(data, unit, 0));
}

// ---------------- reports ----------------

$("showResolved").addEventListener("change", renderReports);

function renderReports() {
  renderTiles();
  const box = $("reportList");
  box.replaceChildren();
  const list = reports.filter((r) => $("showResolved").checked || r.status !== "resolved");
  if (list.length === 0) return box.append(el("p", "No open reports.", "muted"));
  list.forEach((r) => {
    const div = el("div", null, "report");
    const head = el("div", null, "row");
    head.append(el("strong", r.category || "Report"),
      el("span", r.status === "resolved" ? "resolved" : "open", `badge ${r.status === "resolved" ? "" : "open"}`),
      el("span", `${r.name || r.email || ""} · ${r.lockId ? `lock ${r.lockId}` : "no lock"} · ${toDate(r.createdAt)?.toLocaleString() ?? ""}`, "muted"));
    div.append(head, el("p", r.text || ""));
    if (r.photo) {
      const img = el("img");
      img.src = `data:image/jpeg;base64,${r.photo}`;
      img.alt = "Photo from the rider";
      div.append(img);
    }
    if (r.adminReply) div.append(el("p", `Reply: ${r.adminReply}`, "muted"));
    const reply = el("textarea");
    reply.placeholder = "Reply to the rider (shown in the app)";
    const save = (resolved) => async () => {
      const text = reply.value.trim();
      const change = { status: resolved ? "resolved" : "open" };
      if (text) Object.assign(change, { adminReply: text, repliedAt: serverTimestamp() });
      await updateDoc(doc(db, "reports", r.id), change)
        .then(() => logAction(resolved ? "Report resolved" : "Report reopened", r.id, text))
        .catch((e) => toast(`Could not save: ${e.code}`));
    };
    const actions = el("div", null, "row");
    actions.append(button(r.status === "resolved" ? "Reopen" : "Reply and resolve", save(r.status !== "resolved")));
    if (r.status !== "resolved") actions.append(button("Reply only", save(false), "small ghost"));
    div.append(reply, actions);
    box.append(div);
  });
}

// ---------------- users ----------------

function renderUsers() {
  const rows = $("userRows");
  rows.replaceChildren();
  const s = $("userSearch").value.trim().toLowerCase();
  const list = [...users.entries()].sort((a, b) => (a[1].email || "").localeCompare(b[1].email || ""))
    .filter(([, u]) => !s || `${u.name || ""} ${u.email || ""}`.toLowerCase().includes(s));
  for (const [uid, u] of list) {
    const tr = el("tr", null, "clickable");
    tr.onclick = () => openProfile(uid);
    const pic = el("td");
    pic.append(avatar(u));
    tr.append(pic, el("td", u.name || "-"), el("td", u.email || "-"),
      el("td", u.disabled ? `${u.role || "user"} (blocked)` : u.role || "user", u.disabled ? "low" : ""),
      el("td", u.lockId ? `Lock ${u.lockId}` : "-"), el("td", u.activeDevice?.platform || "-"));
    const actions = el("td");
    if (uid !== me.uid) {
      const toAdmin = u.role !== "admin";
      actions.append(button(toAdmin ? "Make admin" : "Make user", async (e) => {
        e.stopPropagation();
        if (!confirm(`${toAdmin ? "Make" : "Remove admin from"} ${u.email}?`)) return;
        if (toAdmin && !(await confirmWithPassword(`Give ${u.email} full admin rights.`))) return;
        await updateDoc(doc(db, "users", uid), { role: toAdmin ? "admin" : "user" })
          .then(() => logAction(toAdmin ? "Made admin" : "Made user", u.email))
          .catch((e) => toast(`Could not change the role: ${e.code}`));
      }));
      actions.append(button("Reset password", async (e) => {
        e.stopPropagation();
        if (!u.email || !confirm(`Send a password reset email to ${u.email}?`)) return;
        await sendPasswordResetEmail(auth, u.email)
          .then(() => { toast(`Reset email sent to ${u.email}`, true); logAction("Password reset sent", u.email); })
          .catch((err) => toast(`Could not send: ${err.code}`));
      }));
      actions.append(button(u.disabled ? "Enable" : "Disable", (e) => {
        e.stopPropagation();
        if (!confirm(`${u.disabled ? "Allow" : "Block"} sign-in for ${u.email}?`)) return;
        accountRequest(u.disabled ? "enable" : "disable", uid, u);
      }));
      actions.append(button("Delete", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete the account of ${u.email}? The login and profile are removed, the lock becomes free, ride history is kept.`)) return;
        if (!(await confirmWithPassword(`Delete the account of ${u.email}.`))) return;
        accountRequest("delete", uid, u);
      }, "small danger-btn"));
    }
    tr.append(actions);
    rows.append(tr);
  }
}

/** Disable, enable or delete another user's login: the lock server does it with the admin key. */
async function accountRequest(action, uid, u) {
  try {
    const ref = await addDoc(collection(db, "admin_requests"), {
      uid: me.uid, action, target: uid, status: "pending", at: serverTimestamp(),
    });
    await logAction(`Account ${action}`, u.email);
    toast(`${action} ${u.email}: waiting for the server…`, true);
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      toast(`${action} ${u.email}: the server did not answer. It must be running; try again then.`);
    }, 30000);
    stop = onSnapshot(ref, (snap) => {
      const status = snap.data()?.status;
      if (!status || status === "pending") return;
      clearTimeout(timer);
      stop();
      toast(`${action} ${u.email}: ${status}`, status === "done");
    });
  } catch (err) {
    toast(`Could not send the request: ${err.code || err.message}`);
  }
}

$("userSearch").addEventListener("input", renderUsers);

let profileUid = null;
function openProfile(uid) {
  profileUid = uid;
  renderProfile();
  $("profile").hidden = false;
  $("profile").scrollIntoView({ behavior: "smooth" });
}
$("profileClose").onclick = () => { profileUid = null; $("profile").hidden = true; };

function renderProfile() {
  if (!profileUid) return;
  const u = users.get(profileUid) || {};
  const mine = rides.filter((r) => r.uid === profileUid);
  const myReports = reports.filter((r) => r.uid === profileUid);
  $("profileTitle").textContent = `${u.name || "-"} <${u.email || ""}>`;
  $("profilePhoto").replaceWith(Object.assign(avatar(u, true), { id: "profilePhoto" }));
  $("pRides").textContent = mine.length;
  $("pKm").textContent = mine.reduce((a, r) => a + rideKm(r), 0).toFixed(1);
  $("pCo2").textContent = mine.reduce((a, r) => a + (r.co2SavedKg || 0), 0).toFixed(1);
  $("pReports").textContent = myReports.length;
  $("profileInfo").textContent = `Role ${u.role || "user"} · ${u.lockId ? `lock ${u.lockId}` : "no lock"} · `
    + `phone ${u.activeDevice?.platform || "-"} · alarms ${u.pushToken ? "on" : "off"} · `
    + `location consent ${u.locationConsent === true ? "yes" : u.locationConsent === false ? "no" : "not asked"} · `
    + `joined ${toDate(u.createdAt)?.toLocaleDateString() ?? "-"}`;
  const rl = $("profileRides");
  rl.replaceChildren();
  if (mine.length === 0) rl.append(el("li", "No rides yet.", "muted"));
  mine.slice(0, 10).forEach((r) => rl.append(el("li",
    `${toDate(r.startAt)?.toLocaleString() ?? ""} · ${r.minutes ?? "?"} min · ${rideKm(r).toFixed(2)} km · ${r.status}`)));
  const pl = $("profileReports");
  pl.replaceChildren();
  if (myReports.length === 0) pl.append(el("li", "No reports.", "muted"));
  myReports.slice(0, 10).forEach((r) => pl.append(el("li",
    `${toDate(r.createdAt)?.toLocaleString() ?? ""} · ${r.category || ""} · ${r.status}`)));
}

// ---------------- locks ----------------

function renderLocks() {
  const rows = $("lockRows");
  rows.replaceChildren();
  [...locks.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([id, l]) => {
    const tr = el("tr");
    tr.append(el("td", id), el("td", l.mac || "-"), el("td", l.imei || "-"), el("td", l.bleKey ? "set" : "default"),
      el("td", l.assignedTo ? riderName(l.assignedTo) : "-"));
    const actions = el("td");
    actions.append(button("Edit", () => openLockForm(id)));
    tr.append(actions);
    rows.append(tr);
  });
}

function openLockForm(id) {
  editing = id;
  const l = id ? locks.get(id) || {} : {};
  $("lockFormTitle").textContent = id ? `Edit lock ${id}` : "Add lock";
  $("fLockId").value = id || "";
  $("fLockId").disabled = !!id;
  $("fMac").value = l.mac || "";
  $("fImei").value = l.imei || "";
  $("fKey").value = l.bleKey || "";
  const sel = $("fRider");
  sel.replaceChildren(new Option("No rider", ""));
  [...users.entries()].sort((a, b) => (a[1].email || "").localeCompare(b[1].email || ""))
    .forEach(([uid, u]) => sel.append(new Option(`${u.name || ""} <${u.email}>${u.lockId && u.lockId !== id ? ` (has lock ${u.lockId})` : ""}`, uid)));
  sel.value = l.assignedTo || "";
  $("lockDelete").hidden = !id;
  $("lockError").textContent = "";
  $("lockForm").hidden = false;
  $("lockForm").scrollIntoView({ behavior: "smooth" });
}

$("lockAdd").onclick = () => openLockForm(null);
$("lockCancel").onclick = () => { $("lockForm").hidden = true; };

$("lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = (editing || $("fLockId").value).trim();
  const mac = $("fMac").value.trim().toUpperCase().replaceAll("-", ":");
  const imei = $("fImei").value.trim();
  const key = $("fKey").value.trim();
  const rider = $("fRider").value || null;
  const err = (t) => { $("lockError").textContent = t; };
  if (!id || id.includes("/")) return err("Enter the lock number.");
  if (!editing && locks.has(id)) return err("This lock number already exists.");
  if (!MAC_RE.test(mac)) return err("MAC must look like 8C:59:DD:00:01:AF");
  if (imei && !/^\d{15}$/.test(imei)) return err("IMEI must be 15 digits.");
  if (key && key.length !== 8) return err("BLE key must be 8 characters.");
  try {
    await setDoc(doc(db, "locks", id), { mac, imei: imei || null, bleKey: key || null }, { merge: true });
    if ((locks.get(id)?.assignedTo || null) !== rider || !editing) await assignLock(id, rider);
    await logAction(editing ? "Lock edited" : "Lock added", id, `MAC ${mac} IMEI ${imei || "-"} rider ${rider ? riderName(rider) : "-"}`);
    toast(`Lock ${id} saved`, true);
    $("lockForm").hidden = true;
  } catch (e2) {
    err(`Could not save: ${e2.code || e2.message}`);
  }
});

/** Same rules as UserService.assignLock in the app: one lock per rider, one rider per lock. */
async function assignLock(lockId, uid) {
  await runTransaction(db, async (tx) => {
    const lockRef = doc(db, "locks", lockId);
    const lock = await tx.get(lockRef);
    const oldOwner = lock.data()?.assignedTo || null;
    let user = null, userOldLock = null;
    if (uid) {
      user = await tx.get(doc(db, "users", uid));
      userOldLock = user.data()?.lockId || null;
    }
    if (oldOwner && oldOwner !== uid) tx.update(doc(db, "users", oldOwner), { lockId: null });
    if (uid) {
      if (userOldLock && userOldLock !== lockId) tx.update(doc(db, "locks", userOldLock), { assignedTo: null });
      tx.update(doc(db, "users", uid), { lockId });
    }
    tx.update(lockRef, { assignedTo: uid });
  });
}

$("lockDelete").onclick = async () => {
  const id = editing;
  if (!id || !confirm(`Delete lock ${id}? Its rider loses the bike; ride history is kept.`)) return;
  if (!(await confirmWithPassword(`Delete lock ${id}.`))) return;
  try {
    await runTransaction(db, async (tx) => {
      const lockRef = doc(db, "locks", id);
      const lock = await tx.get(lockRef);
      const owner = lock.data()?.assignedTo;
      if (owner) {
        const user = await tx.get(doc(db, "users", owner));
        if (user.data()?.lockId === id) tx.update(doc(db, "users", owner), { lockId: null });
      }
      tx.delete(lockRef);
    });
    await logAction("Lock deleted", id);
    toast(`Lock ${id} deleted`, true);
    $("lockForm").hidden = true;
  } catch (e) {
    $("lockError").textContent = `Could not delete: ${e.code || e.message}`;
  }
};

// ---------------- service area ----------------

function renderArea() {
  if (!areaMap) return;
  const a = area || { enabled: false, lat: 40.5235, lng: -8.5152, radiusM: 1000 };
  $("aEnabled").checked = !!a.enabled;
  $("aLat").value = a.lat; $("aLng").value = a.lng; $("aRadius").value = a.radiusM;
  drawArea();
  areaMap.setView([a.lat, a.lng], 14);
}

function drawArea() {
  const lat = Number($("aLat").value), lng = Number($("aLng").value), r = Number($("aRadius").value) || 1000;
  if (areaCircle) areaCircle.remove();
  areaCircle = L.circle([lat, lng], { radius: r, color: "#1e1e1e", fillColor: "#bfd42f", fillOpacity: .25 }).addTo(areaMap);
}

function initAreaMap() {
  if (areaMap) return areaMap.invalidateSize();
  areaMap = L.map("areaMap");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
  }).addTo(areaMap);
  areaMap.on("click", (e) => {
    $("aLat").value = e.latlng.lat.toFixed(6);
    $("aLng").value = e.latlng.lng.toFixed(6);
    drawArea();
  });
  ["aLat", "aLng", "aRadius"].forEach((id) => $(id).addEventListener("input", drawArea));
  renderArea();
}

$("areaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const next = {
    enabled: $("aEnabled").checked,
    lat: Number($("aLat").value), lng: Number($("aLng").value), radiusM: Number($("aRadius").value),
  };
  if (!(Math.abs(next.lat) <= 90 && Math.abs(next.lng) <= 180 && next.radiusM >= 100)) {
    return toast("Check latitude, longitude and radius (at least 100 m)");
  }
  await setDoc(doc(db, "settings", "geofence"), next)
    .then(() => { toast("Service area saved", true); logAction("Service area saved", "geofence", JSON.stringify(next)); })
    .catch((err) => toast(`Could not save: ${err.code}`));
});

// ---------------- admin log ----------------

function renderLog(entries) {
  const rows = $("logRows");
  rows.replaceChildren();
  entries.forEach((e) => {
    const tr = el("tr");
    tr.append(el("td", toDate(e.at)?.toLocaleString() ?? "-"), el("td", e.email || e.uid), el("td", e.action),
      el("td", e.target || ""), el("td", e.details || ""));
    rows.append(tr);
  });
}

// ---------------- messages and offers to riders ----------------
// messages/{id} = { title, text, to: "all" | uid, push, status, uid (admin), createdAt }.
// The rider app lists them under the bell. With push, the lock server sends a phone
// notification and sets status to "sent" with the number of phones (sentTo).

function renderMsgTo() {
  const sel = $("mTo");
  const keep = sel.value;
  sel.replaceChildren(new Option("All riders", "all"));
  [...users.entries()].sort((a, b) => (a[1].name || a[1].email || "").localeCompare(b[1].name || b[1].email || ""))
    .forEach(([uid, u]) => sel.append(new Option(`${u.name || "No name"} <${u.email}>`, uid)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "all";
}

function msgPhoneText(m) {
  if (!m.push) return "no";
  switch (m.status) {
    case "pending": return "sending…";
    case "sent": return `sent to ${m.sentTo ?? 0} phone${m.sentTo === 1 ? "" : "s"}`;
    case "expired": return "not sent (lock server was off)";
    default: return m.status || "-";
  }
}

function renderMessages() {
  const rows = $("msgRows");
  rows.replaceChildren();
  $("noMsgs").hidden = messages.length > 0;
  messages.forEach((m) => {
    const tr = el("tr");
    const to = m.to === "all" ? "All riders" : (users.get(m.to)?.name || users.get(m.to)?.email || "one rider");
    const del = el("td");
    del.append(button("Delete", async () => {
      if (!confirm(`Delete the message "${m.title}"? Riders will no longer see it.`)) return;
      try {
        await deleteDoc(doc(db, "messages", m.id));
        await logAction("Delete message", to, m.title);
      } catch (e) { toast(`Could not delete (${e.code || e.message})`); }
    }, "small ghost"));
    tr.append(el("td", toDate(m.createdAt)?.toLocaleString() ?? "-"), el("td", to), el("td", m.title || ""),
      el("td", m.text || "", "msgtext"), el("td", msgPhoneText(m)), del);
    rows.append(tr);
  });
}

$("msgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("msgError").textContent = "";
  const to = $("mTo").value || "all";
  const title = $("mTitle").value.trim();
  const text = $("mText").value.trim();
  const push = $("mPush").checked;
  if (!title || !text) return ($("msgError").textContent = "Write a title and a message.");
  const who = to === "all" ? "all riders" : (users.get(to)?.name || users.get(to)?.email || "this rider");
  if (!confirm(`Send "${title}" to ${who}${push ? " as a phone notification too" : ""}?`)) return;
  try {
    await addDoc(collection(db, "messages"), {
      title, text, to, push, status: push ? "pending" : "saved", uid: me.uid, createdAt: serverTimestamp(),
    });
    await logAction("Message", who, title);
    toast(`Message sent to ${who}`, true);
    $("mTitle").value = "";
    $("mText").value = "";
  } catch (err) {
    $("msgError").textContent = `Could not send (${err.code || err.message}).`;
  }
});

// ---------------- tabs ----------------

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
  if (b.dataset.tab === "bikes") map?.invalidateSize();
  if (b.dataset.tab === "area") initAreaMap();
  if (b.dataset.tab === "stats") { renderStats(); renderAlarmChart(); }
}));

// Charts are drawn at the card's real width, so redraw them when the window changes size
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (me && !$("tab-stats").hidden) renderStats();
    if (me && selected && !$("bike").hidden) renderDataHistory();
  }, 200);
});
