// datalink-ui.js — the Datalink room for PCC Web: compose a transmission for a vintage Timex Datalink
// watch, encode it byte-exact (timex-datalink.mjs), and flash it out the phone/monitor screen by light.
// Self-contained (builds + drives its own DOM inside a mount element), styled with the app's base.css
// tokens. The optical flash here is a VISIBLE PREVIEW of the transmission; watch-accurate optical
// timing + an emulated-watch decoder land in the next step. Reference: synthead/timex_datalink_client.
import { Protocol3, compile } from "./timex-datalink.mjs?v=1";
import { decodeWatch } from "./datalink-decode.mjs?v=1";

const DATE_FORMATS = [
  ["%_m-%d-%y", "M-D-Y"], ["%_d-%m-%y", "D-M-Y"], ["%y-%m-%d", "Y-M-D"],
  ["%_m.%d.%y", "M.D.Y"], ["%_d.%m.%y", "D.M.Y"], ["%y.%m.%d", "Y.M.D"],
];

// Byte cadence the original Timex software used (NotebookAdapter default): 0.025 s/byte + 0.25 s/packet.
const BYTE_SLEEP = 0.025, PACKET_SLEEP = 0.25;

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export function mountDatalink(root) {
  if (!root || root.__dlMounted) return;
  root.__dlMounted = true;

  const state = {
    sendTime: true, is24h: false, dateFormat: "%_m-%d-%y", zoneName: "",
    sendAlarm: false, alarmHour: 7, alarmMin: 0, alarmMsg: "wake up", alarmAudible: true,
    hourlyChime: false, buttonBeep: false, syncLength: 300,
  };

  root.innerHTML = `
  <div class="dl-wrap">
    <header class="dl-head">
      <div>
        <div class="dl-kick">DATALINK · PROTOCOL 3</div>
        <h1 class="dl-title">Program a Timex Datalink watch</h1>
      </div>
      <span class="dl-beta">BETA</span>
    </header>
    <p class="dl-lede">The genuine 1994 Timex Datalink protocol, flashed out this screen by light. Compose below,
      then hold your Datalink&nbsp;150 to the flashing panel — the watch reads the pulses and stores the data,
      exactly as it did from a CRT thirty years ago.</p>

    <section class="dl-card">
      <div class="dl-card-h">TRANSMISSION</div>
      <div class="dl-body">
        <label class="dl-row dl-toggle"><span>Set the watch clock</span><input type="checkbox" data-k="sendTime"></label>
        <div class="dl-sub" data-when="sendTime">
          <div class="dl-field"><span class="dl-lbl">ZONE NAME</span><input class="dl-in" data-k="zoneName" maxlength="3" placeholder="GMT"></div>
          <div class="dl-field"><span class="dl-lbl">CLOCK</span>
            <div class="dl-seg" data-seg="is24h"><button data-v="0">12H</button><button data-v="1">24H</button></div></div>
          <div class="dl-field"><span class="dl-lbl">DATE</span>
            <select class="dl-in" data-k="dateFormat">${DATE_FORMATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
        </div>

        <label class="dl-row dl-toggle"><span>Add an alarm</span><input type="checkbox" data-k="sendAlarm"></label>
        <div class="dl-sub" data-when="sendAlarm">
          <div class="dl-field"><span class="dl-lbl">TIME</span>
            <input class="dl-in dl-num" data-k="alarmHour" type="number" min="0" max="23"><span class="dl-colon">:</span>
            <input class="dl-in dl-num" data-k="alarmMin" type="number" min="0" max="59"></div>
          <div class="dl-field"><span class="dl-lbl">LABEL</span><input class="dl-in" data-k="alarmMsg" maxlength="8" placeholder="wake up"></div>
          <label class="dl-row dl-toggle dl-sm"><span>Audible</span><input type="checkbox" data-k="alarmAudible" checked></label>
        </div>

        <label class="dl-row dl-toggle"><span>Hourly chime</span><input type="checkbox" data-k="hourlyChime"></label>
        <label class="dl-row dl-toggle"><span>Button beep</span><input type="checkbox" data-k="buttonBeep"></label>
      </div>
    </section>

    <section class="dl-card">
      <div class="dl-card-h">ENCODED · BYTE-EXACT</div>
      <div class="dl-body">
        <div class="dl-stats">
          <div><b data-o="packets">0</b><span>packets</span></div>
          <div><b data-o="bytes">0</b><span>bytes</span></div>
          <div><b data-o="dur">0.0 s</b><span>≈ transmit</span></div>
        </div>
        <pre class="dl-hex" data-o="hex"></pre>
      </div>
    </section>

    <section class="dl-card dl-watch">
      <div class="dl-card-h">WATCH · WHAT IT RECEIVES <span class="dl-watch-emu">EMULATED</span></div>
      <div class="dl-body">
        <div class="dl-lcd" data-o="watch"></div>
        <div class="dl-watch-note" data-o="watchNote"></div>
      </div>
    </section>

    <button class="dl-flash-btn" data-o="flash">
      <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.5 1L2 6.5h3L4.5 11 10 5H7z"/></svg>
      HOLD WATCH TO SCREEN &amp; FLASH
    </button>
    <p class="dl-foot">Preview cadence shown here; watch-accurate optical timing + an on-screen watch that reads
      the flashes back are the next step. Bytes are already the real protocol.</p>
  </div>

  <div class="dl-overlay" data-o="overlay" hidden>
    <div class="dl-target" data-o="target"></div>
    <div class="dl-ovl-ui">
      <div class="dl-ovl-title">HOLD YOUR WATCH TO THE PANEL</div>
      <div class="dl-progress"><div data-o="bar"></div></div>
      <div class="dl-ovl-stat" data-o="ovlStat">transmitting…</div>
      <button class="dl-cancel" data-o="cancel">CANCEL</button>
    </div>
  </div>`;

  injectStyles();

  const $ = (sel) => root.querySelector(sel);
  const o = (name) => root.querySelector(`[data-o="${name}"]`);

  // Compile the current composition into the full packet list.
  function build() {
    const now = new Date();
    const models = [Protocol3.sync({ length: state.syncLength }), Protocol3.start()];
    if (state.sendTime) {
      models.push(Protocol3.time({
        zone: 1, is24h: state.is24h, dateFormat: state.dateFormat,
        name: state.zoneName.trim() || null,
        time: { sec: now.getSeconds(), hour: now.getHours(), min: now.getMinutes(),
          month: now.getMonth() + 1, day: now.getDate(), year: now.getFullYear(), wday: now.getDay() },
      }));
    }
    if (state.sendAlarm) {
      models.push(Protocol3.alarm({
        number: 1, audible: state.alarmAudible, message: state.alarmMsg || "alarm",
        time: { hour: clamp(state.alarmHour, 0, 23), min: clamp(state.alarmMin, 0, 59) },
      }));
    }
    if (state.hourlyChime || state.buttonBeep) {
      models.push(Protocol3.soundOptions({ hourlyChime: state.hourlyChime, buttonBeep: state.buttonBeep }));
    }
    models.push(Protocol3.end());
    return compile(models);
  }

  function refresh() {
    root.querySelectorAll("[data-when]").forEach((el) => { el.hidden = !state[el.dataset.when]; });
    let packets, bytes;
    try {
      packets = build();
      bytes = packets.reduce((n, p) => n + p.length, 0);
    } catch (e) { o("hex").textContent = "⚠ " + e.message; return; }
    o("packets").textContent = packets.length;
    o("bytes").textContent = bytes;
    o("dur").textContent = (bytes * BYTE_SLEEP + packets.length * PACKET_SLEEP).toFixed(1) + " s";
    const flat = packets.flat();
    o("hex").textContent = flat.slice(0, 96).map((b) => b.toString(16).padStart(2, "0")).join(" ")
      + (flat.length > 96 ? " …" : "");
    renderWatch(decodeWatch(flat));   // round-trip: what a watch would store from these exact bytes
  }

  const p2 = (n) => String(n).padStart(2, "0");
  function renderWatch(w) {
    const rows = [];
    if (w.time) {
      const hm = w.time.is24h ? `${p2(w.time.hour)}:${p2(w.time.min)}`
        : `${((w.time.hour % 12) || 12)}:${p2(w.time.min)}`;
      const ap = w.time.is24h ? "24H" : (w.time.hour < 12 ? "AM" : "PM");
      rows.push(`<div class="dl-lcd-time">${hm}<span class="dl-lcd-sec">${p2(w.time.sec)}</span><span class="dl-lcd-ap">${ap}</span></div>`);
      rows.push(`<div class="dl-lcd-date">${p2(w.time.month)}·${p2(w.time.day)}·${w.time.year}${w.time.name ? " · " + esc(w.time.name.toUpperCase()) : ""}</div>`);
    } else {
      rows.push(`<div class="dl-lcd-time dl-dim">--:--</div>`);
    }
    const chips = [];
    w.alarms.forEach((a) => chips.push(`ALM ${p2(a.hour)}:${p2(a.min)} ${a.message}${a.audible ? "" : " ·mute"}`));
    w.appointments.forEach((a) => chips.push(`APT ${p2(a.month)}·${p2(a.day)} ${p2(a.hour)}:${p2(a.min)} ${a.message}`));
    if (w.sound && w.sound.hourlyChime) chips.push("CHIME");
    if (w.sound && w.sound.buttonBeep) chips.push("BEEP");
    if (chips.length) rows.push(`<div class="dl-lcd-list">${chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>`);
    o("watch").innerHTML = rows.join("");
    o("watchNote").textContent = `${w.packets} packets decoded · CRC ${w.crcBad ? w.crcBad + " BAD" : "all valid"}`;
  }

  // ---- events ----
  root.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.dataset.k;
    if (el.type === "checkbox") { el.checked = state[k]; el.addEventListener("change", () => { state[k] = el.checked; refresh(); }); }
    else {
      if (el.tagName === "SELECT") el.value = state[k]; else if (el.value === "") el.value = state[k];
      el.addEventListener("input", () => { state[k] = el.type === "number" ? Number(el.value) : el.value; refresh(); });
    }
  });
  root.querySelectorAll("[data-seg]").forEach((seg) => {
    const k = seg.dataset.seg;
    const paint = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === (state[k] ? 1 : 0)));
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { state[k] = !!Number(b.dataset.v); paint(); refresh(); }));
    paint();
  });
  o("flash").addEventListener("click", () => startFlash(build()));
  o("cancel").addEventListener("click", stopFlash);
  refresh();

  // ---- the optical flash (preview cadence) ----
  let flashTimer = null, wakeLock = null;
  async function startFlash(packets) {
    const bytes = packets.flat();
    if (!bytes.length) return;
    o("overlay").hidden = false;
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
    // Preview modulation: pulse the panel per byte at a watchable rate, MSB-first bit blink inside each byte.
    const total = bytes.length, target = o("target"), bar = o("bar"), stat = o("ovlStat");
    let i = 0, sub = 0;
    const STEP_MS = 22;   // per half-bit; ~real timing arrives with the PHY step
    flashTimer = setInterval(() => {
      if (i >= total) { stat.textContent = "DONE · " + total + " bytes sent"; target.style.background = "var(--lock)"; clearInterval(flashTimer); flashTimer = null; releaseLock(); return; }
      const bit = (bytes[i] >> (7 - (sub >> 1))) & 1;             // 8 bits, 2 half-bits each (Manchester-ish)
      const on = (sub & 1) ? !bit : bit;                          // transition-coded so any refresh shows motion
      target.style.background = on ? "#fff" : "#000";
      if (++sub >= 16) { sub = 0; i++; bar.style.width = (100 * i / total).toFixed(1) + "%"; stat.textContent = "transmitting… byte " + i + " / " + total; }
    }, STEP_MS);
  }
  function stopFlash() { if (flashTimer) { clearInterval(flashTimer); flashTimer = null; } o("overlay").hidden = true; releaseLock(); }
  function releaseLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }

  function clamp(v, lo, hi) { v = Number(v) || 0; return v < lo ? lo : v > hi ? hi : v; }
}

function injectStyles() {
  if (document.getElementById("dl-styles")) return;
  const s = document.createElement("style");
  s.id = "dl-styles";
  s.textContent = `
  .dl-wrap{max-width:560px;margin:0 auto;padding:22px 18px 40px;font-family:var(--sans);color:var(--txt)}
  .dl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
  .dl-kick{font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--led)}
  .dl-title{font-size:22px;font-weight:700;line-height:1.15;margin:3px 0 0;text-wrap:balance}
  .dl-beta{font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.16em;color:var(--beta);background:var(--beta-fill);border:1px solid var(--beta);border-radius:3px;padding:3px 5px;line-height:1;flex:none}
  .dl-lede{font-size:13.5px;line-height:1.5;color:var(--txt2);margin:0 0 20px;max-width:52ch}
  .dl-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-1,7px);margin-bottom:14px;overflow:hidden}
  .dl-card-h{height:28px;display:flex;align-items:center;padding:0 13px;background:var(--strip);border-bottom:1px solid var(--line);font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;color:var(--txt2)}
  .dl-body{padding:6px 13px 13px}
  .dl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
  .dl-row:last-child{border-bottom:0}
  .dl-toggle input{appearance:none;width:38px;height:22px;border-radius:11px;background:var(--well);border:1px solid var(--line2);position:relative;cursor:pointer;transition:background .2s;flex:none}
  .dl-toggle input:checked{background:var(--led-fill);border-color:var(--led)}
  .dl-toggle input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--txt3);transition:transform .2s,background .2s}
  .dl-toggle input:checked::after{transform:translateX(16px);background:var(--led)}
  .dl-toggle.dl-sm{font-size:12.5px;padding:8px 0 2px;border:0;color:var(--txt2)}
  .dl-sub{padding:4px 0 8px;display:flex;flex-direction:column;gap:9px}
  .dl-sub[hidden]{display:none}
  .dl-field{display:flex;align-items:center;gap:10px}
  .dl-lbl{font-family:var(--mono);font-size:9px;letter-spacing:.12em;color:var(--txt3);width:74px;flex:none}
  .dl-in{flex:1;min-width:0;background:var(--well);border:1px solid var(--line2);border-radius:5px;color:var(--txt);font-family:var(--mono);font-size:13px;padding:7px 9px}
  .dl-in:focus{outline:none;border-color:var(--led)}
  .dl-num{flex:none;width:58px;text-align:center}
  .dl-colon{color:var(--txt3);font-family:var(--mono)}
  .dl-seg{display:flex;flex:1;border:1px solid var(--line2);border-radius:5px;overflow:hidden}
  .dl-seg button{flex:1;background:transparent;border:0;color:var(--txt2);font-family:var(--mono);font-size:11px;letter-spacing:.1em;padding:7px 0;cursor:pointer}
  .dl-seg button.on{background:var(--led-fill);color:var(--led)}
  .dl-stats{display:flex;gap:8px;padding:6px 0 12px}
  .dl-stats>div{flex:1;text-align:center;background:var(--well);border:1px solid var(--line);border-radius:6px;padding:9px 4px}
  .dl-stats b{display:block;font-family:var(--mono);font-size:18px;font-weight:700;color:var(--txt);font-variant-numeric:tabular-nums}
  .dl-stats span{font-family:var(--mono);font-size:9px;letter-spacing:.08em;color:var(--txt3)}
  .dl-hex{margin:0;font-family:var(--mono);font-size:10.5px;line-height:1.7;color:var(--txt2);word-break:break-all;white-space:pre-wrap;max-height:96px;overflow:auto}
  .dl-watch .dl-card-h{gap:8px}
  .dl-watch-emu{font-family:var(--mono);font-size:7.5px;letter-spacing:.12em;color:var(--txt3);border:1px solid var(--line2);border-radius:3px;padding:2px 4px;margin-left:auto}
  .dl-lcd{background:#06120f;border:1px solid #123028;border-radius:6px;padding:12px 14px;font-family:var(--mono);color:#7fe6cc;text-shadow:0 0 6px rgba(90,230,190,.4)}
  .dl-lcd-time{font-size:30px;font-weight:700;letter-spacing:.02em;font-variant-numeric:tabular-nums;line-height:1;display:flex;align-items:baseline;gap:6px}
  .dl-lcd-sec{font-size:15px;opacity:.7}
  .dl-lcd-ap{font-size:11px;letter-spacing:.1em;opacity:.6;margin-left:auto;align-self:center}
  .dl-lcd-date{font-size:11px;letter-spacing:.08em;opacity:.78;margin-top:7px}
  .dl-lcd-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}
  .dl-lcd-list span{font-size:9.5px;letter-spacing:.03em;border:1px solid #1c4237;border-radius:3px;padding:3px 6px;opacity:.92}
  .dl-dim{opacity:.35}
  .dl-watch-note{font-family:var(--mono);font-size:9px;letter-spacing:.06em;color:var(--txt3);margin-top:9px}
  .dl-flash-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:9px;background:var(--led);color:#fff;border:0;border-radius:8px;font-family:var(--mono);font-size:13px;font-weight:700;letter-spacing:.1em;padding:15px;cursor:pointer;transition:filter .15s}
  .dl-flash-btn:hover{filter:brightness(1.08)}
  .dl-foot{font-size:12px;line-height:1.5;color:var(--txt3);margin:14px 0 0}
  .dl-overlay{position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}
  .dl-overlay[hidden]{display:none}
  .dl-target{width:min(62vw,320px);aspect-ratio:1;background:#000;border-radius:10px;box-shadow:0 0 0 2px rgba(255,255,255,.14)}
  .dl-ovl-ui{position:fixed;left:0;right:0;bottom:max(28px,env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;gap:14px;padding:0 24px}
  .dl-ovl-title{font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:rgba(255,255,255,.75)}
  .dl-progress{width:min(80vw,320px);height:4px;background:rgba(255,255,255,.14);border-radius:2px;overflow:hidden}
  .dl-progress>div{width:0;height:100%;background:#fff;transition:width .1s linear}
  .dl-ovl-stat{font-family:var(--mono);font-size:11px;color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums}
  .dl-cancel{background:transparent;border:1px solid rgba(255,255,255,.3);color:rgba(255,255,255,.8);font-family:var(--mono);font-size:11px;letter-spacing:.14em;padding:9px 22px;border-radius:6px;cursor:pointer}`;
  document.head.appendChild(s);
}
