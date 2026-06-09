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

function _repaint() {
    try { if (cc.engine && cc.engine.repaintInEditMode) cc.engine.repaintInEditMode(); }
    catch (e) { /* ignore */ }
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

// Set a (possibly dotted) property on `target`. Walk to the parent of the leaf,
// then assign. Used for component properties like `string`, `fontSize`, etc.
function _setDeep(target, path, value) {
    const parts = path.split('.');
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]];
        if (cur == null) throw new Error('property path broke at "' + parts[i] + '"');
    }
    cur[parts[parts.length - 1]] = value;
}

// Node-level transform props need engine setters (plain objects won't assign to
// a Vec3 getter). Returns true if handled.
function _setNodeTransform(node, prop, value) {
    switch (prop) {
        case 'position':
            node.setPosition(value.x || 0, value.y || 0, value.z || 0); return true;
        case 'x': node.x = value; return true;
        case 'y': node.y = value; return true;
        case 'z': node.z = value; return true;
        case 'angle': node.angle = value; return true;
        case 'rotation': node.angle = -value; return true;
        case 'scale':
            if (value && typeof value === 'object') node.setScale(value.x, value.y);
            else node.setScale(value);
            return true;
        case 'scaleX': node.scaleX = value; return true;
        case 'scaleY': node.scaleY = value; return true;
        case 'width': node.width = value; return true;
        case 'height': node.height = value; return true;
        case 'anchorX': node.anchorX = value; return true;
        case 'anchorY': node.anchorY = value; return true;
        case 'active': node.active = !!value; return true;
        case 'name': node.name = String(value); return true;
        case 'opacity': node.opacity = value; return true;
        case 'color':
            if (value && typeof value === 'object')
                node.color = cc.color(value.r || 0, value.g || 0, value.b || 0, value.a == null ? 255 : value.a);
            return true;
        default: return false;
    }
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

    nodeCreate: _handler(function (opt) {
        opt = opt || {};
        const node = new cc.Node(opt.name || 'NewNode');
        const parent = opt.parentUuid ? _node(opt.parentUuid) : _scene();
        if (!parent) throw new Error('parent not found: ' + opt.parentUuid);
        parent.addChild(node);
        if (opt.position) node.setPosition(opt.position.x || 0, opt.position.y || 0, opt.position.z || 0);
        _repaint();
        return { created: true, uuid: node.uuid, name: node.name };
    }),

    nodeDelete: _handler(function (uuid) {
        const node = _node(uuid);
        if (!node) throw new Error('node not found: ' + uuid);
        if (node === _scene()) throw new Error('cannot delete the scene root');
        node.destroy();
        _repaint();
        return { deleted: true, uuid: uuid };
    }),

    nodeAddComponent: _handler(function (uuid, className) {
        const node = _node(uuid);
        if (!node) throw new Error('node not found: ' + uuid);
        const comp = node.addComponent(className);
        _repaint();
        return { added: !!comp, uuid: uuid, component: className };
    }),

    // property: a node-level transform (e.g. "position", "angle", "active") or
    // a component-qualified path (e.g. "cc.Label.string", "cc.Sprite.enabled").
    nodeSetProperty: _handler(function (uuid, property, value) {
        const node = _node(uuid);
        if (!node) throw new Error('node not found: ' + uuid);

        // Component-qualified? Find a component whose class name prefixes it.
        const comps = node._components || [];
        for (let i = 0; i < comps.length; i++) {
            const cn = (cc.js && cc.js.getClassName) ? cc.js.getClassName(comps[i]) : null;
            if (cn && property.indexOf(cn + '.') === 0) {
                _setDeep(comps[i], property.slice(cn.length + 1), value);
                _repaint();
                return { set: true, uuid: uuid, property: property, on: cn };
            }
        }

        // Node-level: transform props need engine setters; everything else is a
        // best-effort deep assignment.
        if (!_setNodeTransform(node, property, value)) {
            _setDeep(node, property, value);
        }
        _repaint();
        return { set: true, uuid: uuid, property: property, on: 'node' };
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
