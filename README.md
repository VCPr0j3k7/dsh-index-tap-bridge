# dsh-index-tap-bridge

**让依赖 `tapIndex` 注入脚本的 DSH 插件，在官方 Harness 桌面版里也能生效。**

装上它之后，那些"插件列表显示已启用、但挂件/按钮/样式死活不出现"的插件就会开始工作。
原插件一个字节都不用改。

---

## 它修的是什么问题

`@deepseek-ai/dsh-host-webserver` 有两条往 `index.html` 里塞东西的通道：

| 通道 | 谁在用 | 官方桌面版 |
|---|---|---|
| 结构化注入行 `webserver/index-inject`（一等公民） | 官方插件（`dsh-client-modules` 等） | ✅ 生效 |
| `tapIndex(html => html)`（逃生舱） | 相当多第三方插件 | ❌ **永不调用** |

原因是官方桌面版**不渲染 Host 的 index.html**：

- 窗口加载的是外壳自带的 SPA（自定义 scheme `dsh-app://app/`，来自 `dsh-web-frontend/dist`）；
- Host 启动完成后，只在 IPC 上报一次 `collectIndexInjections()` 的结果，外壳按注入行的 `kind` 逐条应用；
- `tapIndex` 注册的变换**只在 `renderIndex()` 里被执行**，而 `renderIndex()` 只由 Host 自己的
  fallback 渲染 index 时触发 —— 桌面版走不到那条路。

所以症状是：插件加载零报错、列表里显示"启用"，但它注入的 `<script>` / `<style>` 从未被加载。

> 官方源码注释原话：`applyIndexTaps()` 是 *"the escape hatch for markup no IndexInjection row expresses"*。

## 安装

```bash
# 装到你要用的 profile（web 是 dsh 首次运行时自动创建的那个）
dsh plugin --profile web add github:VCPr0j3k7/dsh-index-tap-bridge
```

`desktop` profile（官方 Harness 桌面版）同理，把 `web` 换成 `desktop` 即可：

```bash
dsh plugin --profile desktop add github:VCPr0j3k7/dsh-index-tap-bridge
```

不需要手动改 `dsh.profile.bundles` —— `dsh plugin` 在跑完 pnpm 后会做一次
`reconcilePlugins()`，凡是声明了 `dsh.bundle.patch` 的依赖会被自动追加进 bundle 层栈。

确认生效：

```bash
dsh --profile web --dump-config      # 输出里应能看到 index-tap-bridge
```

装完**重启**目标 harness。桌面版是启动时加载插件的，正在跑的实例不会热更新。

## 它怎么工作

在 `webserver/index-inject` 发射的那一刻（此时所有插件都已加载、tap 都已注册）：

1. 读 `webServer.indexTaps`（`tapIndex()` 就是往这个数组里 push，见官方实现）；
2. 把每个变换跑在一份最小骨架 HTML 上，取出它**新增**的标记；
3. 翻译成结构化注入行，push 进注入表；
4. 同 `kind` 同载荷去重，不重复推。

**原插件完全无感。** 它的变换照旧留在 `indexTaps` 里，浏览器 / `dsh web` 那条走
`renderIndex()` 的路径行为不变 —— 桥接只在桌面外壳里启用（见下）。

### 翻译规则

| 原标记 | 翻译成 |
|---|---|
| `<script src="U">` | `{ kind: 'script-src', src: 'U' }` |
| `<script>内联</script>` | `{ kind: 'script', text, placement }` |
| `<style>…</style>` | `{ kind: 'style', text }` |
| `<link>` / `div` `span` `template` `noscript` `iframe` `meta` | `{ kind: 'html', placement, html }` |

`<script>` 必须单独映射成 `script` / `script-src`，**不能**用 `html` 行兜住 —— 桌面前端的
`html` 行走 `insertAdjacentHTML()`，这样插进去的 `<script>` 不会执行。

## 只在桌面外壳里启用

判据是 `process.argv` 前两位里含 `dsh-desktop-host`（官方外壳正是这样 spawn Host 的）。
这是唯一能可靠区分"Host 的 index 会不会被渲染"的信号 —— 用 Electron / `--expose-internals`
之类的特征会把自包含外壳（自己加载 Host URL、走 `renderIndex()` 那条路）一起误判进来，
导致重复注入。

需要排障时可以强制覆盖：

```bash
DSH_INDEX_TAP_BRIDGE=on    # 强制启用
DSH_INDEX_TAP_BRIDGE=off   # 强制关闭
```

## 验证

```bash
npm test
```

`test/check.mjs` 是纯逻辑自检（23 项），不依赖 DSH 运行时，覆盖各种翻译分支、空载荷丢弃、
顺序保持、不可翻译标记的上报，以及桌面外壳判定。当前 23/23 通过。

端到端效果：装好后重启桌面版，原本不出挂件的插件应该开始出现。若插件有日志，能看到它注入的
资源被请求。

## 已知边界

- **它只翻译"能翻译的"。** `tapIndex` 里如果做的是**修改**已有标记（而不是新增），翻译不出来 ——
  会 `console.warn` 列出被忽略的标记，不会静默吞掉。
- **官方若改动 `indexTaps` 这个字段名，桥接会安静地不做事**（有 `Array.isArray` 守卫，不报错）。
  届时应改用包装 `tapIndex()` 的方式实现。
- **`<canvas>` 之类不会被硬塞进 `html` 行**：`insertAdjacentHTML` 无法表达"替换已有节点"的语义，
  硬翻译会产出错误结果，所以这类标记会被明确报为"未翻译"。
- **官方桌面版的插件库开关会重写 `dsh.profile.bundles`**（内部会调 `sanitizeProfile(...)`
  清理非官方 bundle）。如果哪天桥接突然失效，第一件事是检查 `bundles` 里它还在不在。

## 许可证

[MIT](./LICENSE)
