# dsh-index-tap-bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](./package.json)

[English](./README.en.md) | **简体中文**

为 DeepSeek Harness (DSH) 提供 `tapIndex` 注入通道的兼容层，使依赖该通道的第三方插件在官方
Harness 桌面版中同样生效。

本插件以独立 bundle 形式装入 DSH profile，无需修改目标插件的任何源码。

---

## 目录

- [问题背景](#问题背景)
- [环境要求](#环境要求)
- [安装](#安装)
- [卸载](#卸载)
- [工作原理](#工作原理)
- [翻译规则](#翻译规则)
- [启用条件](#启用条件)
- [测试](#测试)
- [已知限制](#已知限制)
- [许可](#许可)

## 问题背景

`@deepseek-ai/dsh-host-webserver` 提供两条向 `index.html` 注入内容的通道：

| 通道 | 主要使用者 | 官方桌面版 |
| --- | --- | --- |
| 结构化注入行（`webserver/index-inject` 事件） | 官方插件（`dsh-client-modules` 等） | 生效 |
| 索引变换（`tapIndex(html => html)`） | 大量第三方插件 | **不生效** |

原因在于官方桌面版不渲染 Host 的 `index.html`：

1. 窗口加载的是外壳内置的 SPA（自定义 scheme `dsh-app://app/`，资源来自 `dsh-web-frontend/dist`）；
2. Host 启动完成后，仅通过 IPC 上报一次 `collectIndexInjections()` 的结果，由外壳按注入行的
   `kind` 逐条应用；
3. `tapIndex` 注册的变换仅在 `renderIndex()` 内执行，而 `renderIndex()` 只会在 Host 自行渲染
   index 时被触发 —— 桌面版不会走到该路径。

由此产生的现象是：插件加载过程无任何报错，插件列表中也显示为已启用，但其注入的
`<script>` / `<style>` 从未被加载。

> `@deepseek-ai/dsh-host-webserver` 源码中对 `applyIndexTaps()` 的注释原文：
> *"the escape hatch for markup no IndexInjection row expresses"*

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | `^22.19.0 \|\| >=24` |
| DeepSeek Harness | 已在官方桌面版 `0.1.7-rc.2` 上验证 |

## 安装

```bash
# 装入指定 profile（web 为 dsh 首次运行时自动创建的 profile）
dsh plugin --profile web add github:VCPr0j3k7/dsh-index-tap-bridge
```

官方 Harness 桌面版使用 `desktop` profile：

```bash
dsh plugin --profile desktop add github:VCPr0j3k7/dsh-index-tap-bridge
```

无需手动修改 `dsh.profile.bundles`。`dsh plugin` 在 pnpm 执行完毕后会运行一次
`reconcilePlugins()`，凡声明了 `dsh.bundle.patch` 的依赖会被自动追加进 bundle 层栈。

确认已登记：

```bash
dsh --profile web --dump-config      # 输出中应包含 index-tap-bridge
```

安装完成后需**重启**目标 harness。桌面版在启动时加载插件，运行中的实例不会热更新。

## 卸载

```bash
dsh plugin --profile desktop rm dsh-index-tap-bridge
```

`reconcilePlugins()` 会在依赖被移除后同步清理 `dsh.profile.bundles` 中的对应条目；若发现残留，
手动删除该条目即可。卸载后同样需要重启 harness。

## 工作原理

在 `webserver/index-inject` 事件发射的时刻（此时所有插件均已加载、tap 均已注册）：

1. 读取 `webServer.indexTaps`（`tapIndex()` 的实现即向该数组 push，参见官方实现）；
2. 将每个变换作用于一份最小骨架 HTML，提取其**新增**的标记；
3. 将新增标记翻译为结构化注入行，push 进注入表；
4. 按 `kind` 与载荷去重，避免重复推送。

整个过程对原插件透明：其变换仍保留在 `indexTaps` 中，浏览器与 `dsh web` 经由 `renderIndex()`
的路径行为不变。桥接逻辑仅在桌面外壳中启用，判据见[启用条件](#启用条件)。

## 翻译规则

| 原始标记 | 翻译结果 |
| --- | --- |
| `<script src="U">` | `{ kind: 'script-src', src: 'U' }` |
| `<script>内联代码</script>` | `{ kind: 'script', text, placement }` |
| `<style>…</style>` | `{ kind: 'style', text }` |
| `<link>`、`div`、`span`、`template`、`noscript`、`iframe`、`meta` | `{ kind: 'html', placement, html }` |

`<script>` 必须单独映射为 `script` / `script-src`，不能由 `html` 行承载：桌面前端对 `html` 行
使用 `insertAdjacentHTML()`，以此方式插入的 `<script>` 不会被执行。

## 启用条件

判据为 `process.argv` 的前两位中是否包含 `dsh-desktop-host`（官方外壳正是以该方式 spawn Host）。
这是目前唯一能可靠区分「Host 的 index 是否会被渲染」的信号 —— 若改用 Electron 或
`--expose-internals` 等特征判断，会将自包含外壳（自行加载 Host URL、走 `renderIndex()` 路径）
一并误判，导致重复注入。

排障时可强制覆盖：

| 环境变量 | 取值 | 作用 |
| --- | --- | --- |
| `DSH_INDEX_TAP_BRIDGE` | `on` | 强制启用 |
| `DSH_INDEX_TAP_BRIDGE` | `off` | 强制关闭 |

## 测试

```bash
npm test
```

`test/check.mjs` 为纯逻辑自检（23 项），不依赖 DSH 运行时，覆盖各翻译分支、空载荷丢弃、
顺序保持、不可翻译标记的上报，以及桌面外壳判定。当前 23/23 通过。

端到端验证：安装并重启桌面版后，原本不显示挂件的插件应开始正常工作；若插件带有日志，
可观察到其注入的资源被请求。

## 已知限制

- **仅翻译可翻译的标记。** 若 `tapIndex` 中执行的是**修改**已有标记（而非新增），则无法翻译。
  此类标记会通过 `console.warn` 列出，不会被静默忽略。
- **官方若变更 `indexTaps` 字段名，桥接将静默失效**（存在 `Array.isArray` 守卫，不抛错）。
  届时需改为包装 `tapIndex()` 的方式实现。
- **`<canvas>` 一类标记不会被强行翻译为 `html` 行**：`insertAdjacentHTML` 无法表达「替换已有
  节点」的语义，强行翻译会产出错误结果，因此此类标记会被明确报告为未翻译。
- **官方桌面版的插件库开关会重写 `dsh.profile.bundles`**（内部调用 `sanitizeProfile(...)` 清理
  非官方 bundle）。若桥接突然失效，应首先检查 `bundles` 中该条目是否仍然存在。

## 许可

[MIT](./LICENSE)
