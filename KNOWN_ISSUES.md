# cocos-mcp-2x 已知 Bug（Cocos Creator 2.4.x）

记录实际使用 MCP 操作 2.4 项目时踩到的 bridge 缺陷，方便后续修复。
环境：Cocos Creator 2.4.15，bridge 版本 2，引擎 2.4。

> **状态（v0.3.1）**：Bug 1、Bug 2 均已修复，见各节顶部的「✅ 已修复」说明。
> 修复需在真实编辑器里复测（见 README / 仓库提交说明）。

---

## Bug 1 ★严重：通过 `manage_node` 创建的节点/组件，`manage_scene save` 后不会写入磁盘

> **✅ 已修复**：`manage_node` 的 create / delete / add_component / set_property
> 不再用 `scene.js` 里的原始 `cc` 调用，而是改走编辑器**受管场景命令**
> `Editor.Ipc.sendToPanel('scene', 'scene:create-node-by-classid' / 'scene:add-component' /
> 'scene:set-property' / 'scene:delete-nodes', …)`（`main.js` 的 `sceneIpc()`）。
> 这些命令与 Hierarchy/Inspector 同源，会自动进 Undo 并标脏，`manage_scene save`
> 即可正常落盘。`scene.js` 仅保留只读查询（tree/get/current）和
> `nodeResolveProp`（为 set-property 解析 id/path/type）。
> 依据：Cocos 论坛 API 备忘 forum.cocos.org/t/topic/92605 + 2.4 IPC reference。
> 下面保留原始分析与 `.fire` 手注入法，作为历史记录 / 兜底参考。

### 现象
1. `manage_node create` 创建节点、`add_component` 挂组件，都返回成功；
2. `manage_node tree` 也能看到新节点；
3. 调用 `manage_scene save` 返回 `{"saved": true}`；
4. **但磁盘上的 `.fire` 文件里根本没有这个节点**；
5. 预览/重新打开场景后，新节点和组件全部消失（"做了但什么也看不见"的根因）。

### 根因
- `scene.js` 的 `nodeCreate`（`main.js`/`scene.js`，约 `scene.js:164-172`）用原始的
  `new cc.Node()` + `parent.addChild(node)` 直接改实时场景图；
  `nodeAddComponent`（`scene.js:184-190`）用 `node.addComponent(className)`；
  `nodeSetProperty`（`scene.js:194-216`）也是直接赋值。
  这些操作**绕过了编辑器的脏标记 / Undo 系统**，只调了 `_repaint()`（`scene.js:38`，仅重绘）。
- `manage_scene save`（`main.js:529`）只是发 `Editor.Ipc.sendToMain('scene:save-scene')`
  （等同 Ctrl+S）。编辑器的 save-scene 序列化的是它**自己管理的节点表**，认为场景"未脏"，
  于是跳过写盘 / 不包含这些 raw 节点。

### 已验证的关键事实
- 实时场景里节点存在、`_objFlags === 0`（可序列化）、组件挂载正常；
- 在场景进程里 `Editor.serialize(cc.director.getScene())` 的输出**包含**该节点
  → 说明序列化本身没问题，纯粹是 save 流程没把它纳入 / 没标脏；
- 手动发 `Editor.Ipc.sendToMain('scene:dirty')` 和 `sendToPanel('scene','scene:dirty')`
  **都不能**让 save 写盘。

### 建议修复（任选其一）
1. **改用编辑器受管的节点 API**（推荐）：`nodeCreate` / `nodeAddComponent` 改走
   `Editor.Ipc.sendToPanel('scene', 'scene:create-nodes-by-uuids' / 'scene:add-component', ...)`
   或 2.4 的 `scene:create-node-by-classid`，让操作进入 Undo / 脏标记体系，save 才会持久化。
2. **创建后强制标脏**：找到 2.4 真正生效的标脏入口（`scene:dirty` 无效），在每次
   create/add_component/set_property 后调用，再 save。
3. **兜底：bridge 端直接序列化写文件**——但 `Editor.serialize(scene)` 会包含编辑器
   gizmo 节点（Editor Scene Background/Foreground 等），需要先剔除，复杂，不推荐。

### 临时绕过（本次采用）
直接编辑 `.fire`（扁平数组 + `__id__` 索引引用）注入节点+组件：
- 组件 `__type__` = 脚本 UUID 的压缩值，用
  `Editor.Utils.UuidUtils.compressUuid(uuid, false)`（**第二参数必须 `false`**；
  传 `true` 会过度压缩头部，得到 `28DD...` 而非文件里用的 `280c3...` 形式）；
- 追加节点对象、组件对象，并把节点的 `__id__` 加进父节点的 `_children`；
- `manage_asset refresh` 或重新打开场景后，编辑器即可正确加载。

---

## Bug 2：`manage_asset refresh` 刷新已编译脚本/场景时，bridge 回复超时

> **✅ 已修复**：`manage_asset refresh` 改为 **fire-and-forget**——发起
> `Editor.assetdb.refresh(url)` 后立即返回 `{refreshing:true, url}`，不再等回调，
> 因此不会触发 30s 桥接超时（`main.js` 的 refresh 分支）。刷新/重编译仍在后台进行，
> 完成情况用 `read_console` 或重新查询确认。

### 现象
对 `.js` / `.fire` 调 `manage_asset refresh`，常返回
`bridge_unavailable: timeout waiting for reply to 'manage_asset' after 30.0s`。
但实际刷新/重编译多半已经发生（之后桥接会恢复）。

### 根因（推测）
`adbRefresh`（`main.js:330-339`）包了 `Editor.assetdb.refresh(url, cb)`。
刷新已编译脚本会触发编辑器重编译 + 可能的场景重载，回调迟迟不回 /
主进程繁忙，导致超过 `COCOS_MCP_REQUEST_TIMEOUT`（默认 30s）。

### 建议修复
- refresh 类操作用更长的超时，或做成 fire-and-forget（立即返回 `{refreshing:true}`，
  不等回调）；
- 或在回调真正返回前先回 ack，避免阻塞后续命令。

### 注意（非 bridge bug，但相关）
编辑脚本后，**实时场景进程仍缓存旧的脚本模块**，对已存在的组件实例重跑也是旧逻辑；
只有重新 **预览**（preview 会从磁盘重新编译）或重启编辑器才会用上新代码。
调试时别被"改了没效果"误导。

---

## 附：本次连带发现的使用侧坑（非 MCP bug，记录备查）
运行时用「2x2 纯白贴图 + 着色」做背景 Sprite 时：若**先赋 `spriteFrame` 后设
`sizeMode = CUSTOM`**，赋图瞬间节点会被重置成贴图尺寸 2x2 → 整个 UI 缩成 2 像素不可见。
正确顺序：先 `sizeMode = CUSTOM` 再赋 `spriteFrame`，并在之后 `setContentSize(w,h)` 还原。
