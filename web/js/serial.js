// Web Serial wrapper for the Precision Clock Mk IV.
//
// Mirrors `SerialManager.swift`: open at 115200, line-buffered read, send
// sanitised `key = value\r\n` frames, emit 'line' events for each complete
// newline-terminated line received. Everything else (NMEA parsing, sat store,
// polar plot) hangs off the 'line' stream.
//
// Chromium only. `navigator.serial` doesn't exist in Safari/Firefox; callers
// should gate UI on `Clock.isSupported()` before asking the user to connect.

export class Clock extends EventTarget {
    constructor() {
        super();
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this._buffer = '';
        this._readLoopPromise = null;
        this._closing = false;
        this.nmeaConsumers = 0;
    }

    static isSupported() {
        return 'serial' in navigator;
    }

    get isConnected() {
        return this.port !== null && this.writer !== null;
    }

    /// A human label for the connected port. Web Serial deliberately withholds
    /// the OS device path (e.g. cu.usbmodem…) for privacy — getInfo() exposes
    /// only the USB vendor/product IDs — so this is the most specific honest
    /// identifier we can show. Returns '' when no port is open.
    describe() {
        if (!this.port || typeof this.port.getInfo !== 'function') return '';
        const info = this.port.getInfo() || {};
        const hex = (n) => (Number.isInteger(n) ? n.toString(16).padStart(4, '0') : null);
        const vid = hex(info.usbVendorId), pid = hex(info.usbProductId);
        return vid && pid ? `USB ${vid}:${pid}` : 'USB SERIAL';
    }

    /// Prompt the user to pick a serial port and open it at 115200.
    /// Browser requires a user gesture for `requestPort`; call this from
    /// a button click handler, not on page load.
    async connect() {
        if (!Clock.isSupported()) {
            throw new Error('Web Serial is not supported in this browser. Use Chrome, Edge, Arc, Brave, or Opera.');
        }
        if (this.isConnected) return;

        // No vendor/product filter — the Mk IV enumerates as a generic CDC
        // device and the exact IDs vary by board revision. Users pick from
        // the browser's port picker.
        const port = await navigator.serial.requestPort({ filters: [] });
        await port.open({
            baudRate: 115200,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none',
        });

        this.port = port;
        this.writer = port.writable.getWriter();
        this._closing = false;
        // Detect the device vanishing — an unplug, or a `reboot` that re-enumerates USB —
        // which Web Serial signals as a 'disconnect' on navigator.serial for that port. Without
        // this the UI status lingers on "connected" after the link is actually gone.
        this._onSerialDisconnect = (e) => { if (e.target === this.port) this._handleDrop('device disconnected — USB re-enumerated'); };
        navigator.serial.addEventListener('disconnect', this._onSerialDisconnect);
        this._readLoopPromise = this._readLoop();

        this.dispatchEvent(new CustomEvent('status', {
            detail: { connected: true, message: 'Connected' }
        }));

        // Mirror the Mac app: NMEA off on fresh connect so command responses
        // aren't buried in the sat firehose. Re-enabled by requestNMEA().
        this.send('nmea = off');
    }

    // Unexpected loss of the device (unplug / reboot re-enumeration). Distinct from
    // disconnect(), which is the courteous user-initiated teardown. Releases locks, closes
    // the port, and reports disconnected exactly once.
    _handleDrop(message) {
        if (this._closing) return;
        this._closing = true;
        if (this._onSerialDisconnect) { try { navigator.serial.removeEventListener('disconnect', this._onSerialDisconnect); } catch { /* ignore */ } this._onSerialDisconnect = null; }
        try { this.reader && this.reader.releaseLock(); } catch { /* ignore */ }
        this.reader = null;
        try { this.writer && this.writer.releaseLock(); } catch { /* ignore */ }
        this.writer = null;
        try { this.port && this.port.close(); } catch { /* ignore */ }
        this.port = null;
        this.nmeaConsumers = 0;
        this.dispatchEvent(new CustomEvent('status', { detail: { connected: false, message } }));
    }

    async disconnect() {
        if (!this.port) return;
        this._closing = true;
        if (this._onSerialDisconnect) { try { navigator.serial.removeEventListener('disconnect', this._onSerialDisconnect); } catch { /* ignore */ } this._onSerialDisconnect = null; }

        try {
            // Courteous teardown — stop active display modes so the clock
            // falls back to its default face rather than sitting on a stale
            // scroll frame.
            if (this.writer) {
                await this._rawSend('mode_text = 0\r\n');
                await this._rawSend('mode_countdown = 0\r\n');
                await this._rawSend('nmea = all\r\n');
            }
        } catch { /* disconnecting anyway */ }

        try {
            if (this.reader) {
                await this.reader.cancel();
                this.reader.releaseLock();
                this.reader = null;
            }
        } catch { /* ignore */ }

        try {
            if (this.writer) {
                this.writer.releaseLock();
                this.writer = null;
            }
        } catch { /* ignore */ }

        try {
            await this.port.close();
        } catch { /* ignore */ }

        this.port = null;
        this.nmeaConsumers = 0;
        this.dispatchEvent(new CustomEvent('status', {
            detail: { connected: false, message: 'Disconnected' }
        }));
    }

    /// Send a `key = value` command. Appends CRLF, strips control
    /// characters to prevent protocol injection (mirrors SerialManager).
    send(command) {
        if (!this.writer) return;
        const sanitised = [...command].filter(ch => {
            const c = ch.charCodeAt(0);
            return c === 0x20 || (c >= 0x21 && c < 0x7F);
        }).join('');
        this._rawSend(sanitised + '\r\n').catch(err => {
            this.dispatchEvent(new CustomEvent('error', { detail: err }));
        });
    }

    async _rawSend(text) {
        if (!this.writer) return;
        await this.writer.write(this.encoder.encode(text));
    }

    async _readLoop() {
        while (this.port && this.port.readable && !this._closing) {
            this.reader = this.port.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    this._buffer += this.decoder.decode(value, { stream: true });
                    let newlineIdx;
                    while ((newlineIdx = this._buffer.indexOf('\n')) !== -1) {
                        const line = this._buffer.slice(0, newlineIdx + 1);
                        this._buffer = this._buffer.slice(newlineIdx + 1);
                        this.dispatchEvent(new CustomEvent('line', { detail: line }));
                    }
                }
            } catch (err) {
                this.dispatchEvent(new CustomEvent('error', { detail: err }));
            } finally {
                try { this.reader.releaseLock(); } catch { /* ignore */ }
                this.reader = null;
            }
            if (this._closing) break;
        }
        // The loop only exits on its own when port.readable went null — i.e. the device
        // dropped. (A clean disconnect() sets _closing first, so _handleDrop no-ops.)
        if (!this._closing) this._handleDrop('serial stream ended — device disconnected');
    }

    /// Reference-counted NMEA firehose request. Multiple UI panels
    /// (polar, map, globe) can independently ask for NMEA; the clock only
    /// turns it off when the last one releases. Mirrors SerialManager.
    requestNMEA() {
        this.nmeaConsumers += 1;
        if (this.nmeaConsumers === 1) {
            this.send('NMEA = all');
        }
    }

    releaseNMEA() {
        this.nmeaConsumers = Math.max(0, this.nmeaConsumers - 1);
        if (this.nmeaConsumers === 0) {
            this.send('NMEA = off');
        }
    }
}

/// BridgeClock — the same Clock surface over the pccd local bridge daemon (host/pccd).
///
/// pccd owns the physical serial port ONCE and fans it out: chrony gets the SOF-corrected PPS
/// (stratum-1 for the machine), and any number of PCC tabs get the raw NMEA line stream over a
/// localhost WebSocket, with commands flowing back. No port contention, no picker, works in
/// browsers without Web Serial. Protocol: text frames of raw lines both ways; the first frame
/// is "#PCCD v1 device=<path>".
export class BridgeClock extends EventTarget {
    static PORT = 4192;

    /// Is the daemon running? Resolves { device } or null. Fast (350 ms cap) so the connect
    /// button can probe it inline without noticeable delay.
    static async detect() {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 350);
            const r = await fetch(`http://127.0.0.1:${BridgeClock.PORT}/health`, { signal: ctrl.signal });
            clearTimeout(t);
            if (!r.ok) return null;
            const j = await r.json();
            return j && j.pccd ? j : null;
        } catch { return null; }
    }

    static isSupported() { return typeof WebSocket !== 'undefined'; }

    constructor() { super(); this.ws = null; this.device = ''; this.nmeaConsumers = 0; this._closing = false; }

    describe() { return 'PCC BRIDGE · ' + (this.device || `localhost:${BridgeClock.PORT}`); }

    async connect() {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${BridgeClock.PORT}`);
            // Resolve on the daemon's hello frame (immediate after upgrade) rather than onopen,
            // so describe() already knows the device path when the caller stamps the port label.
            // The timeout is a safety net for a daemon too old to send a hello.
            let settled = false;
            const settle = () => { if (!settled) { settled = true; this.ws = ws; resolve(); } };
            ws.onopen = () => setTimeout(settle, 400);
            ws.onerror = () => { if (!settled) { settled = true; reject(new Error('pccd bridge not reachable on localhost:' + BridgeClock.PORT)); } };
            ws.onmessage = (e) => {
                const text = String(e.data);
                if (text.startsWith('#PCCD')) {
                    const m = text.match(/device=(\S+)/);
                    if (m) this.device = m[1];
                    settle();
                }
                // serial lines carry their trailing newline (Clock._readLoop slices inclusive) — match it
                this.dispatchEvent(new CustomEvent('line', { detail: text + '\n' }));
            };
            ws.onclose = () => {
                const wasOpen = this.ws === ws;
                this.ws = null;
                if (wasOpen && !this._closing)
                    this.dispatchEvent(new CustomEvent('status', { detail: { connected: false, message: 'bridge connection lost' } }));
            };
        });
        this.dispatchEvent(new CustomEvent('status', { detail: { connected: true, message: 'Connected via bridge' } }));
        // Behaviour parity with the direct transport: quiet the firehose until requestNMEA().
        this.send('nmea = off');
    }

    async disconnect() {
        this._closing = true;
        try {
            // Same courteous teardown as the direct transport.
            this.send('mode_text = 0');
            this.send('mode_countdown = 0');
            this.send('nmea = all');
        } catch { /* disconnecting anyway */ }
        try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
        this.nmeaConsumers = 0;
        this.dispatchEvent(new CustomEvent('status', { detail: { connected: false, message: 'Disconnected' } }));
    }

    send(command) {
        if (!this.ws || this.ws.readyState !== 1) return;
        const sanitised = [...command].filter(ch => {
            const c = ch.charCodeAt(0);
            return c === 0x20 || (c >= 0x21 && c < 0x7F);
        }).join('');
        try { this.ws.send(sanitised); } catch (err) {
            this.dispatchEvent(new CustomEvent('error', { detail: err }));
        }
    }

    requestNMEA() {
        this.nmeaConsumers += 1;
        if (this.nmeaConsumers === 1) this.send('NMEA = all');
    }
    releaseNMEA() {
        this.nmeaConsumers = Math.max(0, this.nmeaConsumers - 1);
        if (this.nmeaConsumers === 0) this.send('NMEA = off');
    }
}
