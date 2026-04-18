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
        this._readLoopPromise = this._readLoop();

        this.dispatchEvent(new CustomEvent('status', {
            detail: { connected: true, message: 'Connected' }
        }));

        // Mirror the Mac app: NMEA off on fresh connect so command responses
        // aren't buried in the sat firehose. Re-enabled by requestNMEA().
        this.send('nmea = off');
    }

    async disconnect() {
        if (!this.port) return;
        this._closing = true;

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
