'use strict';

/**
 * Cocos MCP (2.4.x) — dockable panel.
 *
 * Mirror of cocos-mcp-3x/panel/index.js, ported to the 2.4 panel API:
 *   - Editor.Panel.extend({ template, style, $, ready, close }) (2.4) instead
 *     of Editor.Panel.define (3.x).
 *   - Editor.Ipc.sendToMain('cocos-mcp-2x:<msg>', ...args, cb(err, data))
 *     instead of Editor.Message.request(pkg, msg, ...).
 *   - this.$<id> auto-bound from the `$` map (2.4) vs this.$.<id> (3.x).
 *
 * Two concerns:
 *   - Python server lifecycle: Start / Stop / status (the server hosts the
 *     WebSocket bridge this extension dials into).
 *   - WebSocket connection: Connect / Disconnect / status.
 * On open it polls both, so it reflects a server running even if started
 * outside the editor.
 */

const PKG = 'cocos-mcp-2x';
const DEFAULT_URL = 'ws://127.0.0.1:6020/cocosmcp';
const DEFAULT_BRIDGE_PORT = 6020;   // WebSocket bridge (extension <-> server)
const DEFAULT_HTTP_PORT = 8799;     // MCP HTTP endpoint (client <-> server)

// Promise wrapper around the callback-style 2.4 IPC.
function ipc(msg) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise((resolve, reject) => {
        Editor.Ipc.sendToMain.apply(Editor.Ipc, [PKG + ':' + msg].concat(args, [
            (err, data) => { if (err) reject(err instanceof Error ? err : new Error(String(err))); else resolve(data); },
        ]));
    });
}

Editor.Panel.extend({
    template: `
<div class="mcp">
    <header>Cocos MCP bridge (2.4)</header>

    <div class="prop"><label>Server URL</label><input id="url" type="text"></div>
    <div class="prop"><label>Bridge port</label><input id="bridgeport" type="text" placeholder="6020"></div>
    <div class="prop"><label>HTTP port</label><input id="httpport" type="text" placeholder="8799"></div>
    <div class="hint">Default ports — bridge 6020, http 8799. If one is in use, change it here, then Start. The Server URL syncs to the bridge port automatically.</div>
    <div class="prop"><label>Server dir</label><input id="serverdir" type="text" placeholder="auto — bundled ./server (leave blank)"></div>
    <div class="hint" id="sinfo">resolving server path…</div>
    <div class="minirow"><button id="resetdir">Use plugin default</button></div>

    <div class="row">
        <button id="start" class="primary">Start Server</button>
        <button id="stop">Stop Server</button>
    </div>
    <div class="state"><span class="dot" id="sdot"></span><span id="sstatus">server: unknown</span></div>

    <div class="sep"></div>

    <div class="row">
        <button id="connect" class="primary">Connect</button>
        <button id="disconnect">Disconnect</button>
    </div>
    <div class="state"><span class="dot" id="dot"></span><span id="status">unknown</span></div>

    <div class="err" id="err"></div>
    <footer>The Python server is bundled in this plugin (./server). Start Server, then Connect.</footer>
</div>`,
    style: `
:host { display: block; }
.mcp { padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 8px; color: #ccc; }
.mcp header { font-weight: bold; font-size: 13px; }
.mcp .prop { display: flex; align-items: center; gap: 8px; }
.mcp .prop label { width: 78px; color: #aaa; flex: none; }
.mcp .prop input { flex: 1; background: #2228; color: #ddd; border: 1px solid #4445; border-radius: 3px; padding: 3px 6px; }
.mcp .row { display: flex; gap: 8px; }
.mcp button { background: #3a3a3a; color: #ddd; border: 1px solid #555; border-radius: 3px; padding: 4px 10px; cursor: pointer; }
.mcp button:hover { background: #454545; }
.mcp button.primary { background: #2b6cb0; border-color: #2b6cb0; color: #fff; }
.mcp button[disabled] { opacity: 0.45; cursor: default; }
.mcp .state { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.mcp .sep { border-top: 1px solid #4444; margin: 4px 0; }
.mcp .dot { width: 10px; height: 10px; border-radius: 50%; background: #888; display: inline-block; }
.mcp .dot.on { background: #3c3; }
.mcp .dot.off { background: #c33; }
.mcp .err { color: #d66; min-height: 14px; white-space: pre-wrap; }
.mcp .hint { color: #888; font-size: 11px; white-space: pre-wrap; word-break: break-all; line-height: 1.4; }
.mcp .hint .bad { color: #d66; }
.mcp .hint .ok { color: #3c3; }
.mcp .minirow { display: flex; justify-content: flex-end; margin-top: -2px; }
.mcp footer { color: #999; margin-top: 6px; }
`,
    $: {
        url: '#url',
        bridgeport: '#bridgeport',
        httpport: '#httpport',
        serverdir: '#serverdir',
        sinfo: '#sinfo',
        resetdir: '#resetdir',
        start: '#start',
        stop: '#stop',
        sstatus: '#sstatus',
        sdot: '#sdot',
        connect: '#connect',
        disconnect: '#disconnect',
        status: '#status',
        dot: '#dot',
        err: '#err',
    },

    _setDisabled(el, on) {
        if (!el) return;
        if (on) el.setAttribute('disabled', '');
        else el.removeAttribute('disabled');
    },
    _bridgePort() {
        const v = parseInt((this.$bridgeport && this.$bridgeport.value) || '', 10);
        return (Number.isFinite(v) && v > 0 && v <= 65535) ? v : DEFAULT_BRIDGE_PORT;
    },
    _httpPort() {
        const v = parseInt((this.$httpport && this.$httpport.value) || '', 10);
        return (Number.isFinite(v) && v > 0 && v <= 65535) ? v : DEFAULT_HTTP_PORT;
    },
    _buildUrl(bridgePort) {
        let host = '127.0.0.1', path = '/cocosmcp';
        const cur = ((this.$url && this.$url.value) || DEFAULT_URL).trim();
        const m = /^ws:\/\/([^/:]+)(?::\d+)?(\/.*)?$/.exec(cur);
        if (m) { host = m[1]; if (m[2]) path = m[2]; }
        return 'ws://' + host + ':' + bridgePort + path;
    },
    _renderServer(s) {
        s = s || {};
        const running = !!s.running;
        this.$sstatus.innerText = running
            ? ('server: running' + (s.managed ? ' (managed)' : ' (external)'))
            : 'server: stopped';
        this.$sdot.className = 'dot ' + (running ? 'on' : 'off');
        this._setDisabled(this.$start, running);
        this._setDisabled(this.$stop, !running);
        this._defaultDir = s.defaultServerDir || '';
        if (this.$serverdir && !this._dirTyped) {
            this.$serverdir.value = s.serverDir || '';
        }
        if (this.$bridgeport && !this._bpTyped && Number.isFinite(s.bridgePort)) {
            this.$bridgeport.value = String(s.bridgePort);
        }
        if (this.$httpport && !this._hpTyped && Number.isFinite(s.httpPort)) {
            this.$httpport.value = String(s.httpPort);
        }
        this._renderServerHint(s);
        this.$err.innerText = s.lastError ? String(s.lastError) : '';
    },
    _renderServerHint(s) {
        if (!this.$sinfo) return;
        if (s.serverDir === undefined) { this.$sinfo.innerText = ''; return; }
        const esc = (t) => String(t == null ? '' : t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const rows = [];
        rows.push('dir: ' + esc(s.serverDir) +
            (s.isDefaultDir ? '  <span class="ok">(auto, bundled)</span>' : '  (custom override)'));
        rows.push(s.pythonExists
            ? 'python: <span class="ok">found</span>'
            : 'python: <span class="bad">NOT FOUND</span> — ' + esc(s.pythonPath));
        if (s.srcExists === false) {
            rows.push('<span class="bad">src/main.py not found under this dir — set a custom Server dir above.</span>');
        }
        if (s.pythonExists === false && s.serverDir) {
            rows.push('fix: open a terminal in the dir above, then run\n' +
                '  python -m venv .venv\n' +
                '  .venv\\Scripts\\python -m pip install -e .\n' +
                '  (slow/timeout? add  -i https://pypi.tuna.tsinghua.edu.cn/simple )');
        }
        this.$sinfo.innerHTML = rows.join('\n');
    },
    _render(s) {
        s = s || {};
        const connected = !!s.connected;
        this.$status.innerText = connected ? 'connected' : 'disconnected';
        this.$dot.className = 'dot ' + (connected ? 'on' : 'off');
        if (!connected && s.lastError) this.$err.innerText = String(s.lastError);
        if (s.url && this.$url && !this._userTyped) this.$url.value = s.url;
    },
    async _start() {
        const bridgePort = this._bridgePort();
        const httpPort = this._httpPort();
        const url = this._buildUrl(bridgePort);
        if (this.$url) this.$url.value = url;
        const dir = ((this.$serverdir && this.$serverdir.value) || '').trim();
        const override = (dir && dir === this._defaultDir) ? '' : dir;
        try {
            await ipc('panel-set-server-dir', override);
            await ipc('panel-set-http-port', httpPort);
            this.$sstatus.innerText = 'server: starting…';
            this._setDisabled(this.$start, true);
            const s = await ipc('panel-start-server', url);
            this._renderServer(s);
        } catch (e) {
            this.$err.innerText = String(e && e.message ? e.message : e);
            this._setDisabled(this.$start, false);
        }
    },
    async _resetDir() {
        try {
            this._dirTyped = false;
            if (this.$serverdir) this.$serverdir.value = '';
            const s = await ipc('panel-set-server-dir', '');
            this._renderServer(s);
        } catch (e) {
            this.$err.innerText = String(e && e.message ? e.message : e);
        }
    },
    async _stop() {
        try {
            this.$sstatus.innerText = 'server: stopping…';
            this._setDisabled(this.$stop, true);
            const s = await ipc('panel-stop-server');
            this._renderServer(s);
        } catch (e) {
            this.$err.innerText = String(e && e.message ? e.message : e);
            this._setDisabled(this.$stop, false);
        }
    },
    async _connect() {
        const url = this._buildUrl(this._bridgePort());
        if (this.$url) this.$url.value = url;
        try {
            const s = await ipc('panel-connect', url);
            this._render(s);
        } catch (e) {
            this.$err.innerText = String(e && e.message ? e.message : e);
        }
    },
    async _disconnect() {
        try {
            const s = await ipc('panel-disconnect');
            this._render(s);
        } catch (e) {
            this.$err.innerText = String(e && e.message ? e.message : e);
        }
    },
    async _poll() {
        try { this._renderServer(await ipc('panel-server-status')); } catch (e) { /* main not ready */ }
        try { this._render(await ipc('panel-status')); } catch (e) { /* idem */ }
    },

    ready() {
        this._userTyped = false;
        this._dirTyped = false;
        this._bpTyped = false;
        this._hpTyped = false;

        if (this.$url) {
            this.$url.value = DEFAULT_URL;
            this.$url.addEventListener('input', () => {
                this._userTyped = true;
                const m = /^ws:\/\/[^/:]+:(\d+)/.exec((this.$url.value || '').trim());
                if (m && this.$bridgeport) { this.$bridgeport.value = m[1]; this._bpTyped = true; }
            });
        }
        if (this.$bridgeport) {
            this.$bridgeport.value = String(DEFAULT_BRIDGE_PORT);
            this.$bridgeport.addEventListener('input', () => {
                this._bpTyped = true;
                this._userTyped = true;
                if (this.$url) this.$url.value = this._buildUrl(this._bridgePort());
            });
        }
        if (this.$httpport) {
            this.$httpport.value = String(DEFAULT_HTTP_PORT);
            this.$httpport.addEventListener('input', () => { this._hpTyped = true; });
        }
        if (this.$serverdir) {
            this.$serverdir.addEventListener('input', () => { this._dirTyped = true; });
        }
        if (this.$resetdir) this.$resetdir.addEventListener('click', () => this._resetDir());
        if (this.$start) this.$start.addEventListener('click', () => this._start());
        if (this.$stop) this.$stop.addEventListener('click', () => this._stop());
        if (this.$connect) this.$connect.addEventListener('click', () => this._connect());
        if (this.$disconnect) this.$disconnect.addEventListener('click', () => this._disconnect());

        this._poll();
        this._timer = setInterval(() => this._poll(), 1500);
    },

    close() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },
});
