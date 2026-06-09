'use strict';

/**
 * Cocos MCP (2.4.x) — scene-context script.
 *
 * Registered via the `scene-script` field in package.json. Its message
 * handlers run inside the *scene process*, where the engine runtime (`cc`)
 * and the live scene graph (`cc.director.getScene()`) are available. The main
 * process (main.js) reaches these via:
 *
 *   Editor.Scene.callSceneScript('cocos-mcp-2x', '<method>', ...args, cb);
 *
 * Each handler receives `(event, ...args)` and replies with
 * `event.reply(errString|null, data)`. Only JSON-serializable data may cross
 * the IPC boundary — we always return plain objects, never live cc.Node refs.
 *
 * This script is READ-ONLY: queries (sceneCurrent / nodeTree / nodeGet /
 * nodeResolveProp) and the eval escape hatch. Scene MUTATIONS (create / delete /
 * add-component / set-property) are NOT done here — raw `cc` edits bypass the
 * editor's dirty/Undo system and would not persist on save. main.js performs
 * them via the editor-managed `Editor.Ipc.sendToPanel('scene', 'scene:…')`
 * commands instead; this script only resolves the dump path/type for them.
 */

// `cc` is a global in the 2.4 scene process (no require needed).

function _coerce(value) {
    if (value === undefined) return null;
    try { JSON.parse(JSON.stringify(value)); return value; }
    catch (e) { return String(value); }
}

function _scene() {
    return cc.director.getScene();
}

// Resolve a node by uuid via the editor's instance registry; fall back to the
// scene root when no uuid is given.
function _node(uuid) {
    if (!uuid) return _scene();
    const n = cc.engine && cc.engine.getInstanceById ? cc.engine.getInstanceById(uuid) : null;
    return n || null;
}

function _trimTree(node, maxDepth, depth) {
    depth = depth || 0;
    if (!node) return null;
    const out = { name: node.name, uuid: node.uuid };
    if (node.active !== undefined) out.active = node.active;
    const children = node.children || [];
    if (depth >= maxDepth) {
        if (children.length) out.childCount = children.length;
    } else {
        out.children = children.map((c) => _trimTree(c, maxDepth, depth + 1));
    }
    return out;
}

function _vec(v) {
    if (!v) return null;
    return { x: v.x, y: v.y, z: (v.z === undefined ? 0 : v.z) };
}

function _nodeSummary(node) {
    const comps = (node._components || []).map((c) => ({
        type: (cc.js && cc.js.getClassName) ? cc.js.getClassName(c) : (c.constructor && c.constructor.name),
        enabled: c.enabled,
    }));
    const pos = node.position || (node.getPosition ? node.getPosition() : null);
    return {
        uuid: node.uuid,
        name: node.name,
        active: node.active,
        position: _vec(pos),
        angle: node.angle,
        scale: { x: node.scaleX, y: node.scaleY },
        anchor: { x: node.anchorX, y: node.anchorY },
        size: (node.width !== undefined) ? { width: node.width, height: node.height } : null,
        parent: node.parent ? node.parent.uuid : null,
        childCount: (node.children || []).length,
        components: comps,
    };
}

// Infer the dump `type` string the editor's set-property command expects.
// Prefer the current value's runtime type; fall back to the new value's shape.
function _inferType(current, fallback) {
    const v = (current !== undefined && current !== null) ? current : fallback;
    if (v === null || v === undefined) return 'cc.Object';
    if (typeof v === 'number') return 'Number';
    if (typeof v === 'boolean') return 'Boolean';
    if (typeof v === 'string') return 'String';
    if (cc.Vec3 && v instanceof cc.Vec3) return 'cc.Vec3';
    if (cc.Vec2 && v instanceof cc.Vec2) return 'cc.Vec2';
    if (cc.Color && v instanceof cc.Color) return 'cc.Color';
    if (cc.Quat && v instanceof cc.Quat) return 'cc.Quat';
    if (typeof v === 'object') {
        if ('x' in v && 'y' in v && 'z' in v && 'w' in v) return 'cc.Quat';
        if ('x' in v && 'y' in v && 'z' in v) return 'cc.Vec3';
        if ('x' in v && 'y' in v) return 'cc.Vec2';
        if ('r' in v && 'g' in v && 'b' in v) return 'cc.Color';
        if ('uuid' in v || '__uuid__' in v) return 'cc.Asset';
    }
    return 'cc.Object';
}

// Wrap a (sync or async) function as a 2.4 scene-script message handler:
// reply(null, data) on success, reply(errMessage) on failure.
function _handler(fn) {
    return function (event) {
        const args = Array.prototype.slice.call(arguments, 1);
        Promise.resolve()
            .then(() => fn.apply(null, args))
            .then((data) => { if (event && event.reply) event.reply(null, _coerce(data)); })
            .catch((e) => { if (event && event.reply) event.reply((e && e.message) ? e.message : String(e)); });
    };
}

module.exports = {

    sceneCurrent: _handler(function () {
        const scene = _scene();
        if (!scene) return { open: false };
        return {
            open: true,
            name: scene.name,
            uuid: scene.uuid,
            childCount: scene.children ? scene.children.length : 0,
        };
    }),

    nodeTree: _handler(function (uuid, maxDepth) {
        const root = _node(uuid);
        if (!root) throw new Error('node/scene not found' + (uuid ? ': ' + uuid : ''));
        return _trimTree(root, (maxDepth == null ? 6 : maxDepth), 0);
    }),

    nodeGet: _handler(function (uuid) {
        const node = _node(uuid);
        if (!node) throw new Error('node not found: ' + uuid);
        return _nodeSummary(node);
    }),

    // Resolve a dotted `property` into the { id, path, type, on } the editor's
    // managed `scene:set-property` command expects. Node mutations themselves are
    // performed by main.js via that command (so they hit Undo + dirty + save);
    // this is read-only inspection of live cc objects, returning plain JSON.
    //   "position"          -> { id: <nodeUuid>, path: "position",  on: "node" }
    //   "cc.Sprite.enabled" -> { id: <compUuid>, path: "enabled",   on: "cc.Sprite" }
    nodeResolveProp: _handler(function (uuid, property) {
        const node = _node(uuid);
        if (!node) throw new Error('node not found: ' + uuid);

        // Component-qualified? Match a component whose class name prefixes it.
        const comps = node._components || [];
        for (let i = 0; i < comps.length; i++) {
            const cn = (cc.js && cc.js.getClassName) ? cc.js.getClassName(comps[i]) : null;
            if (cn && property.indexOf(cn + '.') === 0) {
                const rest = property.slice(cn.length + 1);
                const first = rest.split('.')[0];
                return {
                    id: comps[i].uuid, path: rest, on: cn,
                    type: _inferType(comps[i][first], undefined),
                    isSubProp: rest.indexOf('.') >= 0,
                };
            }
        }

        // Node-level property.
        const first = property.split('.')[0];
        return {
            id: node.uuid, path: property, on: 'node',
            type: _inferType(node[first], undefined),
            isSubProp: property.indexOf('.') >= 0,
        };
    }),

    // Run an arbitrary JS snippet with `cc` and `director` in scope. Wrapped as
    // `(async () => { <code> })()`; the resolved value is returned (coerced).
    evalInScene: _handler(function (code) {
        const director = cc.director;
        const fn = new Function('cc', 'director',
            '"use strict"; return (async () => { ' + code + ' })();');
        return Promise.resolve(fn(cc, director)).then(_coerce);
    }),

    load: function () {},
    unload: function () {},
};
