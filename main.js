'use strict';

/**
 * Cocos MCP (2.4.x) — single-file extension main process, no npm dependencies.
 *
 * Mirror image of cocos-mcp-3x/main.js. Same JSON envelope and same WebSocket
 * client; the differences from 3.x are all in the editor APIs the handlers call:
 *   - Editor.assetdb.* (callbacks) instead of Editor.Message.request('asset-db', ...).
 *   - Editor.Scene.callSceneScript(pkg, method, ...args, cb) (-> scene.js)
 *     instead of Editor.Message.request('scene', ...) / execute-scene-script.
 *   - Editor.log/warn/error hook instead of the console.* hook.
 *   - module.exports = { load, unload, messages: {} } (2.4) instead of 3.x's
 *     exports.methods.
 *
 * Protocol (Python server -> extension):
 *   { "id": "<uuid>", "command": "manage_node", "params": { ... } }
 * Reply (extension -> server):
 *   { "id": "<uuid>", "success": true,  "data":  ... }
 *   { "id": "<uuid>", "success": false, "error": "..." }
 *
 * Contents (top -> bottom):
 *   1. Minimal WebSocket client (RFC 6455, text frames, no `ws` package).
 *   2. Editor.log ring buffer for read_console.
 *   3. Small editor helpers (assetdb / scene-script promise wrappers).
 *   4. Six command handlers.
 *   5. Bridge wiring (connect/disconnect/dispatch).
 *   6. Python server lifecycle (spawn / probe / stop).
 *   7. Extension lifecycle (load/unload) + panel IPC messages (2.4 style).
 */

const net = require('net');
const crypto = require('crypto');
const Path = require('path');
const Fs = require('fs');
const ChildProcess = require('child_process');
const { EventEmitter } = require('events');

const PACKAGE_NAME = 'cocos-mcp-2x';
const DEFAULT_URL = 'ws://127.0.0.1:6020/cocosmcp';
const MAX_FRAME = 16 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Where the Python MCP server lives, and which HTTP port it serves the MCP
// endpoint on. The server ships *inside* this extension (./server), so the
// default dir is resolved relative to this file — the plugin is self-contained
// and portable. The bridge (WebSocket) port is derived from the connection URL
// so it always matches what the panel connects to. Both the dir and the HTTP
// port are overridable from the panel and persisted via Editor.Profile.
const DEFAULT_SERVER_DIR = Path.join(__dirname, 'server');
const DEFAULT_HTTP_PORT = 8799;

// ----------------------------------------------------------------------- //
// 1. Minimal WebSocket client (text frames only) — identical to 3.x.
// ----------------------------------------------------------------------- //

class WsClient extends EventEmitter {
    constructor() {
        super();
        this._socket = null;
        this._buf = Buffer.alloc(0);
        this._handshakeDone = false;
        this._expectedAccept = null;
    }

    connect(urlStr) {
        const m = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(urlStr);
        if (!m) {
            setImmediate(() => this.emit('error', new Error('invalid ws:// url: ' + urlStr)));
            return;
        }
        const host = m[1];
        const port = parseInt(m[2] || '80', 10);
        const path = m[3] || '/';

        const key = crypto.randomBytes(16).toString('base64');
        this._expectedAccept = crypto.createHash('sha1')
            .update(key + WS_GUID).digest('base64');

        const socket = net.createConnection({ host: host, port: port });
        this._socket = socket;
        socket.setNoDelay(true);

        socket.on('connect', () => {
            const req =
                'GET ' + path + ' HTTP/1.1\r\n' +
                'Host: ' + host + ':' + port + '\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n' +
                '\r\n';
            socket.write(req);
        });

        socket.on('data', (chunk) => {
            try { this._onData(chunk); }
            catch (e) { this.emit('error', e); this._teardown(); }
        });
        socket.on('error', (err) => this.emit('error', err));
        socket.on('close', () => {
            this._handshakeDone = false;
            this.emit('close');
        });
    }

    _onData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);

        if (!this._handshakeDone) {
            const end = this._buf.indexOf(Buffer.from('\r\n\r\n'));
            if (end === -1) return;
            const header = this._buf.slice(0, end).toString('utf8');
            this._buf = this._buf.slice(end + 4);
            if (!/^HTTP\/1\.[01] 101/i.test(header)) {
                this.emit('error', new Error('handshake failed: ' + header.split('\r\n')[0]));
                this._teardown(); return;
            }
            const am = header.match(/Sec-WebSocket-Accept:\s*(.+)/i);
            if (!am || am[1].trim() !== this._expectedAccept) {
                this.emit('error', new Error('handshake failed: bad Sec-WebSocket-Accept'));
                this._teardown(); return;
            }
            this._handshakeDone = true;
            this.emit('open');
        }

        while (true) {
            if (this._buf.length < 2) return;
            const b0 = this._buf[0], b1 = this._buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (this._buf.length < 4) return;
                len = this._buf.readUInt16BE(2); offset = 4;
            } else if (len === 127) {
                if (this._buf.length < 10) return;
                const hi = this._buf.readUInt32BE(2);
                const lo = this._buf.readUInt32BE(6);
                if (hi !== 0 || lo > MAX_FRAME) {
                    this.emit('error', new Error('frame too large'));
                    this._teardown(); return;
                }
                len = lo; offset = 10;
            }
            let mask = null;
            if (masked) {
                if (this._buf.length < offset + 4) return;
                mask = this._buf.slice(offset, offset + 4);
                offset += 4;
            }
            if (this._buf.length < offset + len) return;
            let payload = this._buf.slice(offset, offset + len);
            this._buf = this._buf.slice(offset + len);
            if (masked) {
                const u = Buffer.alloc(len);
                for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i & 3];
                payload = u;
            }
            if (opcode === 0x1 && fin) {
                this.emit('message', payload.toString('utf8'));
            } else if (opcode === 0x8) {
                try { this._writeFrame(0x8, Buffer.alloc(0)); } catch (e) {}
                this._teardown(); return;
            } else if (opcode === 0x9) {
                try { this._writeFrame(0xa, payload); } catch (e) {}
            }
        }
    }

    _writeFrame(opcode, data) {
        if (!this._socket || this._socket.destroyed) return;
        const len = data.length;
        let header;
        if (len < 126) {
            header = Buffer.alloc(2 + 4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | len;
        } else if (len < 65536) {
            header = Buffer.alloc(4 + 4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10 + 4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
            header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
        }
        const maskKey = crypto.randomBytes(4);
        maskKey.copy(header, header.length - 4);
        const out = Buffer.alloc(header.length + len);
        header.copy(out, 0);
        for (let i = 0; i < len; i++) out[header.length + i] = data[i] ^ maskKey[i & 3];
        this._socket.write(out);
    }

    send(text) {
        if (!this._handshakeDone) throw new Error('ws not connected');
        this._writeFrame(0x1, Buffer.from(String(text), 'utf8'));
    }

    close() {
        if (this._socket && !this._socket.destroyed && this._handshakeDone) {
            try { this._writeFrame(0x8, Buffer.alloc(0)); } catch (e) {}
        }
        this._teardown();
    }

    _teardown() {
        if (this._socket) {
            try { this._socket.end(); } catch (e) {}
            try { this._socket.destroy(); } catch (e) {}
            this._socket = null;
        }
        this._handshakeDone = false;
    }
}

// ----------------------------------------------------------------------- //
// 2. Console capture — hooks the Editor.log family in this (main) process.
//    Best-effort: captures logs emitted via Editor.log/info/warn/error/
//    success/failed by code running in the extension main process. The editor
//    aggregates logs from several processes; we can only see ours.
// ----------------------------------------------------------------------- //

const _logOriginals = {};
let _consoleBuffer = null;
const CONSOLE_CAPACITY = 500;

// Editor.<fn> -> the read_console level it maps to.
const _LOG_FNS = [
    ['log', 'log'], ['info', 'info'], ['warn', 'warn'],
    ['error', 'error'], ['success', 'info'], ['failed', 'error'],
];

function _stringifyArg(a) {
    if (a && a.stack && typeof a.stack === 'string') return a.stack;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function _installConsoleHook() {
    if (_consoleBuffer) return;
    if (typeof Editor === 'undefined' || !Editor) return;
    _consoleBuffer = { entries: [], seq: 0, capacity: CONSOLE_CAPACITY };
    _LOG_FNS.forEach((p) => {
        const fn = p[0], level = p[1];
        if (typeof Editor[fn] !== 'function') return;
        _logOriginals[fn] = Editor[fn];
        Editor[fn] = function () {
            try {
                _consoleBuffer.seq++;
                _consoleBuffer.entries.push({
                    seq: _consoleBuffer.seq,
                    timestamp: Date.now(),
                    level: level,
                    message: Array.prototype.slice.call(arguments).map(_stringifyArg).join(' '),
                });
                while (_consoleBuffer.entries.length > _consoleBuffer.capacity) {
                    _consoleBuffer.entries.shift();
                }
            } catch (e) { /* never let logging crash */ }
            return _logOriginals[fn].apply(Editor, arguments);
        };
    });
}

function _uninstallConsoleHook() {
    Object.keys(_logOriginals).forEach((k) => {
        try { Editor[k] = _logOriginals[k]; } catch (e) { /* ignore */ }
    });
    for (const k in _logOriginals) delete _logOriginals[k];
    _consoleBuffer = null;
}

// ----------------------------------------------------------------------- //
// 3. Editor helpers
// ----------------------------------------------------------------------- //

function _safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

function _normUrl(u) {
    if (!u) return u;
    if (u.startsWith('db://')) return u;
    if (u.startsWith('assets/')) return 'db://' + u;
    if (u.startsWith('/assets')) return 'db://' + u.slice(1);
    return u;
}

function _err(e) {
    if (!e) return new Error('unknown error');
    return (e instanceof Error) ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e));
}

// --- Editor.assetdb (callback API) -> Promise wrappers ---

function adbQueryAssets(pattern, type) {
    return new Promise((resolve, reject) => {
        try {
            Editor.assetdb.queryAssets(pattern, type || undefined, (err, results) => {
                if (err) return reject(_err(err));
                resolve(results || []);
            });
        } catch (e) { reject(_err(e)); }
    });
}

function adbCreate(url, data) {
    return new Promise((resolve, reject) => {
        try {
            Editor.assetdb.create(url, data == null ? '' : String(data), (err, results) => {
                if (err) return reject(_err(err));
                resolve((results && results[0]) || null);
            });
        } catch (e) { reject(_err(e)); }
    });
}

function adbDelete(urls) {
    return new Promise((resolve, reject) => {
        try {
            Editor.assetdb.delete(urls, (err, results) => {
                if (err) return reject(_err(err));
                resolve(results || []);
            });
        } catch (e) { reject(_err(e)); }
    });
}

// --- Editor.Scene.callSceneScript -> Promise wrapper ---
// All live scene-graph work happens in scene.js (the scene process, where the
// engine `cc` runtime lives). We reach it by name; only JSON crosses the wire.

function callScene(method, ...args) {
    return new Promise((resolve, reject) => {
        try {
            Editor.Scene.callSceneScript(PACKAGE_NAME, method, ...args, (err, result) => {
                if (err) return reject(_err(err));
                resolve(result);
            });
        } catch (e) { reject(_err(e)); }
    });
}

// --- Editor-managed scene IPC -> Promise wrapper ---
// Scene MUTATIONS must go through the scene panel's own commands (the same ones
// the Hierarchy/Inspector use): they record Undo AND mark the scene dirty, so a
// later save actually writes them. Raw `cc` edits in scene.js do NOT persist.
// Requires a scene to be open (the 'scene' panel must be loaded).
function sceneIpc(msg, ...args) {
    return new Promise((resolve, reject) => {
        try {
            Editor.Ipc.sendToPanel('scene', 'scene:' + msg, ...args,
                (err, result) => (err ? reject(_err(err)) : resolve(result)),
                30000);
        } catch (e) { reject(_err(e)); }
    });
}

// queryAssets entries are { url, path, uuid, type, isSubAsset } in 2.4 (no
// `name` field) — derive a display name from the url.
function _assetBrief(a, full) {
    if (!a) return a;
    const url = a.url;
    const brief = {
        name: url ? String(url).split('/').pop() : (a.name || null),
        url: url,
        uuid: a.uuid,
        type: a.type,
        path: a.path,
        isSubAsset: !!a.isSubAsset,
    };
    if (full) brief.file = a.path;
    return brief;
}

// ----------------------------------------------------------------------- //
// 4. Command handlers  (same names/params/return-envelope as cocos-mcp-3x)
// ----------------------------------------------------------------------- //

const handlers = {

    async get_project_info() {
        let scenes = [];
        try {
            const assets = await adbQueryAssets('db://assets/**/*', 'scene');
            scenes = (assets || []).map((a) => ({ url: a.url, uuid: a.uuid, path: a.path }));
        } catch (e) { /* ignore — still report the rest */ }
        const projectPath = _safe(() => Editor.Project.path, null);
        return {
            engine: '2.4',
            projectPath: projectPath,
            projectName: _safe(() => Editor.Project.name, null) ||
                (projectPath ? Path.basename(projectPath) : null),
            assetsRoot: projectPath ? Path.join(projectPath, 'assets') : null,
            editorVersion: _safe(() => (Editor.versions &&
                (Editor.versions['cocos-creator'] || Editor.versions.editor)), null) ||
                _safe(() => Editor.App.version, null),
            sceneCount: scenes.length,
            firstScenes: scenes.slice(0, 20),
            availableCommands: Object.keys(handlers).sort(),
            bridgeVersion: 2,
        };
    },

    async read_console(params) {
        params = params || {};
        if (!_consoleBuffer) {
            return { entries: [], nextCursor: 0, note: 'console hook not active' };
        }
        if (params.action === 'clear') {
            _consoleBuffer.entries.length = 0;
            return { cleared: true };
        }
        const levels = Array.isArray(params.levels) && params.levels.length
            ? new Set(params.levels) : null;
        const contains = (typeof params.contains === 'string') ? params.contains : null;
        const since = (typeof params.since === 'number') ? params.since : -1;
        let count = Number.isFinite(params.count) ? Math.floor(params.count) : 50;
        if (count <= 0) count = 50;
        if (count > 500) count = 500;
        let entries = _consoleBuffer.entries.filter((e) => {
            if (levels && !levels.has(e.level)) return false;
            if (contains && e.message.indexOf(contains) === -1) return false;
            if (e.seq <= since) return false;
            return true;
        });
        if (entries.length > count) entries = entries.slice(entries.length - count);
        const nextCursor = entries.length ? entries[entries.length - 1].seq : Math.max(since, 0);
        return { entries: entries, nextCursor: nextCursor, totalBuffered: _consoleBuffer.entries.length };
    },

    async manage_asset(params) {
        params = params || {};
        const action = params.action || 'list';

        if (action === 'list') {
            const pattern = params.pattern || 'db://assets/**/*';
            let assets = (await adbQueryAssets(pattern, null)) || [];
            const type = params.type;
            if (type) {
                const t = String(type).toLowerCase();
                assets = assets.filter((a) =>
                    (a.type && String(a.type).toLowerCase().indexOf(t) >= 0) ||
                    (a.url && a.url.toLowerCase().endsWith('.' + t)));
            }
            const total = assets.length;
            const limit = Math.min(params.limit || 200, 1000);
            if (assets.length > limit) assets = assets.slice(0, limit);
            return { count: total, returned: assets.length, assets: assets.map((a) => _assetBrief(a)) };
        }

        if (action === 'info') {
            let url = _normUrl(params.url);
            let uuid = params.uuid;
            if (!url && uuid) url = _safe(() => Editor.assetdb.uuidToUrl(uuid), null);
            if (!uuid && url) uuid = _safe(() => Editor.assetdb.urlToUuid(url), null);
            if (!url && !uuid) throw new Error('manage_asset.info needs url or uuid');
            const fspath = uuid ? _safe(() => Editor.assetdb.uuidToFspath(uuid), null) : null;
            const isDir = fspath ? _safe(() => Fs.statSync(fspath).isDirectory(), false) : false;
            return { name: url ? url.split('/').pop() : null, url: url, uuid: uuid, path: fspath, file: fspath, isDirectory: isDir };
        }

        if (action === 'read') {
            let url = _normUrl(params.url);
            let uuid = params.uuid;
            if (!uuid && url) uuid = _safe(() => Editor.assetdb.urlToUuid(url), null);
            if (!url && uuid) url = _safe(() => Editor.assetdb.uuidToUrl(uuid), null);
            const fspath = uuid ? _safe(() => Editor.assetdb.uuidToFspath(uuid), null) : null;
            if (!fspath) throw new Error('asset not found: ' + (params.url || params.uuid));
            const stat = Fs.statSync(fspath);
            if (stat.isDirectory()) throw new Error('cannot read a directory');
            if (stat.size > 1024 * 1024) {
                throw new Error('file too large (>1MB): ' + stat.size + ' bytes');
            }
            const content = Fs.readFileSync(fspath, 'utf8');
            return { url: url, uuid: uuid, file: fspath, size: stat.size, content: content };
        }

        if (action === 'create') {
            const url = _normUrl(params.url);
            if (!url) throw new Error('manage_asset.create needs url');
            const body = (params.content != null) ? String(params.content) : '';
            const info = await adbCreate(url, body);
            return info ? _assetBrief(info, true) : { created: true, url: url };
        }

        if (action === 'delete') {
            const url = _normUrl(params.url);
            if (!url) throw new Error('manage_asset.delete needs url');
            const results = await adbDelete([url]);
            return { deleted: true, count: (results || []).length };
        }

        if (action === 'refresh') {
            const url = _normUrl(params.url) || 'db://assets';
            // Fire-and-forget: refreshing a compiled .js/.fire can trigger a slow
            // recompile + scene reload whose callback may exceed the bridge
            // timeout. Kick it off and return immediately; completion is async
            // (watch read_console). See KNOWN_ISSUES Bug 2.
            try { Editor.assetdb.refresh(url, function () {}); } catch (e) { throw _err(e); }
            return { refreshing: true, url: url };
        }

        throw new Error('manage_asset: unknown action "' + action +
            '" (valid: list, info, read, create, delete, refresh)');
    },

    async manage_scene(params) {
        params = params || {};
        const action = params.action || 'current';

        if (action === 'list') {
            const assets = (await adbQueryAssets('db://assets/**/*', 'scene')) || [];
            return {
                count: assets.length,
                scenes: assets.map((a) => ({ url: a.url, uuid: a.uuid, path: a.path })),
            };
        }

        if (action === 'current') {
            return await callScene('sceneCurrent');
        }

        if (action === 'open') {
            let uuid = params.uuid;
            if (!uuid && params.url) uuid = _safe(() => Editor.assetdb.urlToUuid(_normUrl(params.url)), null);
            if (!uuid) throw new Error('manage_scene.open needs uuid or url');
            // The Assets panel opens scenes via this main-process message; the
            // scene module switches the editor to it asynchronously.
            Editor.Ipc.sendToMain('scene:open-by-uuid', uuid);
            return { opened: true, uuid: uuid };
        }

        if (action === 'save') {
            // Save via the scene panel (the same path Ctrl+S takes). The managed
            // mutations above mark the scene dirty, so this actually writes.
            try {
                await sceneIpc('save-scene');
            } catch (e) {
                // Fallback for builds where save is main-routed.
                try { Editor.Ipc.sendToMain('scene:save-scene'); } catch (e2) { throw e; }
            }
            return { saved: true };
        }

        throw new Error('manage_scene: unknown action "' + action +
            '" (valid: list, current, open, save)');
    },

    async manage_node(params) {
        params = params || {};
        const action = params.action;

        if (action === 'tree') {
            const maxDepth = (params.maxDepth != null) ? Math.max(0, params.maxDepth) : 6;
            return await callScene('nodeTree', params.uuid || null, maxDepth);
        }

        if (action === 'get') {
            if (!params.uuid) throw new Error('manage_node.get needs uuid');
            return await callScene('nodeGet', params.uuid);
        }

        if (action === 'selection') {
            let sel = [];
            try { sel = Editor.Selection.curSelection('node') || []; } catch (e) {}
            return { selected: sel };
        }

        if (action === 'create') {
            // Resolve the parent (default = scene root) so the managed command
            // always gets an explicit uuid.
            let parentUuid = params.parentUuid;
            if (!parentUuid) {
                const cur = await callScene('sceneCurrent');
                parentUuid = (cur && cur.uuid) || '';
            }
            const name = params.name || 'NewNode';
            // classid '' => a plain cc.Node. Reply is the new node's uuid.
            const uuid = await sceneIpc('create-node-by-classid', name, '', parentUuid);
            if (params.position && uuid) {
                const p = params.position;
                await sceneIpc('set-property', {
                    id: uuid, path: 'position', type: 'cc.Vec3',
                    value: { x: p.x || 0, y: p.y || 0, z: p.z || 0 }, isSubProp: false,
                });
            }
            return { created: true, uuid: uuid, name: name, parentUuid: parentUuid };
        }

        if (action === 'delete') {
            if (!params.uuid) throw new Error('manage_node.delete needs uuid');
            await sceneIpc('delete-nodes', [params.uuid]);
            return { deleted: true, uuid: params.uuid };
        }

        if (action === 'add_component') {
            if (!params.uuid) throw new Error('manage_node.add_component needs uuid');
            if (!params.className) throw new Error('manage_node.add_component needs className');
            const componentId = await sceneIpc('add-component', params.uuid, params.className);
            return { added: true, uuid: params.uuid, component: params.className, componentId: componentId };
        }

        if (action === 'set_property') {
            if (!params.uuid) throw new Error('manage_node.set_property needs uuid');
            if (!params.property) throw new Error('manage_node.set_property needs property');
            // Resolve target id (node or component uuid) + dump path + type in the
            // scene process, then apply via the managed set-property command.
            const r = await callScene('nodeResolveProp', params.uuid, params.property);
            if (!r || !r.id) throw new Error('could not resolve property: ' + params.property);
            await sceneIpc('set-property', {
                id: r.id, path: r.path, type: r.type, value: params.value, isSubProp: !!r.isSubProp,
            });
            return { set: true, uuid: params.uuid, property: params.property, on: r.on, type: r.type };
        }

        throw new Error('manage_node: unknown action "' + action +
            '" (valid: tree, get, set_property, create, delete, add_component, selection)');
    },

    async execute_script(params) {
        params = params || {};
        const code = params.code;
        const target = params.target || 'main';
        if (typeof code !== 'string' || !code.trim()) {
            throw new Error('execute_script needs non-empty code');
        }
        if (target === 'scene') {
            const value = await callScene('evalInScene', code);
            return { value: value === undefined ? null : value };
        }
        // target === 'main' — runs here, with Editor.* available but not cc.
        const fn = new Function('Editor', 'require',
            '"use strict"; return (async () => { ' + code + ' })();');
        const value = await fn(Editor, require);
        return { value: _coerceValue(value) };
    },
};

function _coerceValue(v) {
    if (v === undefined) return null;
    try { JSON.parse(JSON.stringify(v)); return v; }
    catch (e) { return String(v); }
}

// ----------------------------------------------------------------------- //
// 5. Bridge wiring  (identical to 3.x)
// ----------------------------------------------------------------------- //

let _ws = null;
let _connected = false;
let _url = DEFAULT_URL;
let _lastError = null;

function _connectionState() {
    return { connected: _connected, url: _url, lastError: _lastError };
}

function _handleFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch (e) { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'hello') return;
    if (typeof frame.command !== 'string' || !frame.id) return;

    const fn = handlers[frame.command];
    const reply = (resp) => {
        try { if (_ws) _ws.send(JSON.stringify(resp)); } catch (e) { /* ignore */ }
    };
    if (!fn) {
        reply({
            id: frame.id, success: false,
            error: 'unknown command: ' + frame.command +
                ' (known: ' + Object.keys(handlers).sort().join(', ') + ')',
        });
        return;
    }
    Promise.resolve()
        .then(() => fn(frame.params || {}))
        .then((data) => reply({ id: frame.id, success: true, data: data }))
        .catch((e) => reply({
            id: frame.id, success: false,
            error: (e && e.message) ? e.message : String(e),
            stack: (e && e.stack) ? String(e.stack) : undefined,
        }));
}

function _connect(url) {
    if (typeof url === 'string' && url.trim()) _url = url.trim();
    if (_ws) {
        try { _ws.close(); } catch (e) { /* ignore */ }
        _ws = null;
    }
    return new Promise((resolve) => {
        let settled = false;
        const ws = new WsClient();

        const onOpen = () => {
            if (settled) return; settled = true;
            _ws = ws;
            _connected = true;
            _lastError = null;
            try {
                ws.send(JSON.stringify({ type: 'hello', client: PACKAGE_NAME, engine: '2.4' }));
            } catch (e) { /* ignore */ }
            resolve(_connectionState());
        };
        const onErr = (err) => {
            _lastError = (err && err.message) ? err.message : String(err);
            if (settled) return; settled = true;
            _connected = false; _ws = null;
            resolve(_connectionState());
        };
        const onClose = () => {
            _connected = false;
            if (_ws === ws) _ws = null;
            if (settled) return; settled = true;
            if (!_lastError) _lastError = 'closed before open';
            resolve(_connectionState());
        };

        ws.on('open', onOpen);
        ws.on('error', onErr);
        ws.on('close', onClose);
        ws.on('message', _handleFrame);

        try { ws.connect(_url); } catch (e) { onErr(e); }
    });
}

function _disconnect() {
    if (_ws) { try { _ws.close(); } catch (e) {} _ws = null; }
    _connected = false;
}

// ----------------------------------------------------------------------- //
// 6. Python server lifecycle (spawn / probe / stop)  — identical to 3.x
//    except config persistence uses 2.4's Editor.Profile (load/get/set/save).
// ----------------------------------------------------------------------- //

let _serverProc = null;          // ChildProcess we spawned (null if none/exited)
let _serverLastError = null;
const _serverLog = [];           // ring buffer of recent server stdout/stderr
let _cfgServerDir = null;        // override of DEFAULT_SERVER_DIR (from Profile/panel)
let _cfgHttpPort = null;         // override of DEFAULT_HTTP_PORT

function _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _serverDir() { return _cfgServerDir || DEFAULT_SERVER_DIR; }
function _httpPort() { return _cfgHttpPort || DEFAULT_HTTP_PORT; }

function _bridgePort() {
    const m = /^ws:\/\/[^/:]+:(\d+)/.exec(_url || '');
    return m ? parseInt(m[1], 10) : 6020;
}

function _pythonPath() {
    const dir = _serverDir();
    return process.platform === 'win32'
        ? Path.join(dir, '.venv', 'Scripts', 'python.exe')
        : Path.join(dir, '.venv', 'bin', 'python');
}

function _pushServerLog(s) {
    String(s).split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        _serverLog.push(line);
        while (_serverLog.length > 200) _serverLog.shift();
    });
}

function _probePort(port, host, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (up) => {
            if (done) return; done = true;
            try { sock.destroy(); } catch (e) {}
            resolve(up);
        };
        sock.setTimeout(timeoutMs || 600);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        try { sock.connect(port, host || '127.0.0.1'); } catch (e) { finish(false); }
    });
}

function _findPidOnPort(port) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve(null);
        ChildProcess.execFile('netstat', ['-ano', '-p', 'TCP'],
            { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const lines = stdout.split(/\r?\n/);
                for (const line of lines) {
                    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
                    if (m && parseInt(m[1], 10) === port) return resolve(parseInt(m[2], 10));
                }
                resolve(null);
            });
    });
}

function _killPid(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        if (process.platform === 'win32') {
            ChildProcess.execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
                { windowsHide: true }, () => resolve());
        } else {
            try { process.kill(pid, 'SIGTERM'); } catch (e) {}
            resolve();
        }
    });
}

async function _serverStatus() {
    const bridgePort = _bridgePort();
    const running = await _probePort(bridgePort);
    const dir = _serverDir();
    const py = _pythonPath();
    return {
        running: running,
        managed: !!(_serverProc && _serverProc.exitCode === null && _serverProc.signalCode === null),
        pid: _serverProc ? _serverProc.pid : null,
        bridgePort: bridgePort,
        httpPort: _httpPort(),
        serverDir: dir,
        defaultServerDir: DEFAULT_SERVER_DIR,
        isDefaultDir: !_cfgServerDir,
        pythonPath: py,
        pythonExists: _safe(() => Fs.existsSync(py), false),
        srcExists: _safe(() => Fs.existsSync(Path.join(dir, 'src', 'main.py')), false),
        lastError: _serverLastError,
        log: _serverLog.slice(-20),
    };
}

async function _startServer() {
    const bridgePort = _bridgePort();
    const httpPort = _httpPort();

    if (await _probePort(bridgePort)) {
        _serverLastError = null;
        return _serverStatus();
    }

    const py = _pythonPath();
    const cwd = Path.join(_serverDir(), 'src');
    if (!Fs.existsSync(py)) {
        _serverLastError = 'python not found: ' + py +
            ' — check the server dir, or create the venv (python -m venv .venv && .venv\\Scripts\\python -m pip install -e .)';
        return _serverStatus();
    }
    if (!Fs.existsSync(cwd)) {
        _serverLastError = 'server src not found: ' + cwd;
        return _serverStatus();
    }

    try {
        const args = ['-m', 'main', '--transport', 'http',
            '--http-port', String(httpPort), '--bridge-port', String(bridgePort)];
        const proc = ChildProcess.spawn(py, args, { cwd: cwd, windowsHide: true });
        _serverProc = proc;
        _serverLastError = null;
        if (proc.stdout) proc.stdout.on('data', (d) => _pushServerLog(d.toString()));
        if (proc.stderr) proc.stderr.on('data', (d) => _pushServerLog(d.toString()));
        proc.on('error', (e) => {
            _serverLastError = 'spawn error: ' + (e && e.message ? e.message : String(e));
        });
        proc.on('exit', (code, sig) => {
            _pushServerLog('[server exited: code=' + code + ' signal=' + sig + ']');
            if (_serverProc === proc) _serverProc = null;
        });
        _editorLog('[' + PACKAGE_NAME + '] launching server: ' + py +
            ' (bridge ' + bridgePort + ', http ' + httpPort + ')');
    } catch (e) {
        _serverLastError = 'failed to start server: ' + (e && e.message ? e.message : String(e));
        return _serverStatus();
    }

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        await _delay(400);
        if (_serverProc == null) break;
        if (await _probePort(bridgePort)) break;
    }
    if (!(await _probePort(bridgePort)) && !_serverLastError) {
        _serverLastError = 'server did not start listening on ' + bridgePort +
            ' within 12s — see the server log';
    }
    return _serverStatus();
}

async function _stopServer() {
    const bridgePort = _bridgePort();
    if (_serverProc && _serverProc.pid) {
        await _killPid(_serverProc.pid);
        _serverProc = null;
    }
    if (await _probePort(bridgePort)) {
        const pid = await _findPidOnPort(bridgePort);
        if (pid) await _killPid(pid);
    }
    _serverLastError = null;
    return _serverStatus();
}

// --- 2.4 config persistence via Editor.Profile (global, all projects) ---

function _profile() {
    return Editor.Profile.load('global://' + PACKAGE_NAME + '.json');
}

function _editorLog() {
    try { Editor.log.apply(Editor, arguments); } catch (e) { /* ignore */ }
}

function _setServerDir(dir) {
    _cfgServerDir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : null;
    try { const p = _profile(); p.set('serverDir', _cfgServerDir); p.save(); } catch (e) {}
}

function _setHttpPort(port) {
    const p = parseInt(port, 10);
    _cfgHttpPort = (Number.isFinite(p) && p > 0 && p <= 65535) ? p : null;
    try { const pf = _profile(); pf.set('httpPort', _cfgHttpPort); pf.save(); } catch (e) {}
}

// ----------------------------------------------------------------------- //
// 7. Extension lifecycle + panel IPC (2.4 style: module.exports.messages)
// ----------------------------------------------------------------------- //

module.exports = {
    load() {
        _installConsoleHook();
        try {
            const p = _profile();
            const dir = p.get('serverDir');
            if (typeof dir === 'string' && dir.trim()) _cfgServerDir = dir.trim();
            const hp = p.get('httpPort');
            if (Number.isFinite(hp)) _cfgHttpPort = hp;
        } catch (e) { /* no persisted override — use defaults */ }
        _editorLog('[' + PACKAGE_NAME + '] loaded — open the panel to start the server and Connect.');
    },

    unload() {
        _disconnect();
        _uninstallConsoleHook();
    },

    // IPC handlers. Each replies via event.reply(err, data); the panel's
    // Editor.Ipc.sendToMain(..., cb) receives (err, data).
    messages: {
        // Menu entry -> open the dockable panel.
        open() {
            Editor.Panel.open(PACKAGE_NAME);
        },

        'panel-connect'(event, url) {
            _connect(url).then((s) => event.reply(null, s),
                (e) => event.reply(_err(e).message));
        },
        'panel-disconnect'(event) {
            _disconnect();
            event.reply(null, _connectionState());
        },
        'panel-status'(event) {
            event.reply(null, _connectionState());
        },
        'panel-start-server'(event, url) {
            if (typeof url === 'string' && url.trim()) _url = url.trim();
            _startServer().then((s) => event.reply(null, s),
                (e) => event.reply(_err(e).message));
        },
        'panel-stop-server'(event) {
            _stopServer().then((s) => event.reply(null, s),
                (e) => event.reply(_err(e).message));
        },
        'panel-server-status'(event) {
            _serverStatus().then((s) => event.reply(null, s),
                (e) => event.reply(_err(e).message));
        },
        'panel-set-server-dir'(event, dir) {
            _setServerDir(dir);
            _serverStatus().then((s) => event.reply(null, s),
                (e) => event.reply(_err(e).message));
        },
        'panel-set-http-port'(event, port) {
            _setHttpPort(port);
            _serverStatus().then((s) => event.reply(null, s),
                (e) => event.reply(_err(e).message));
        },
    },
};
