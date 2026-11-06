# 思维画布 · dsh-flowith-canvas

把 [Flowith](https://flowith.io) 式的**节点思考**搬进 DeepSeek Harness Web UI 的常驻插件：一块可平移缩放的白板，每张卡片是一个问题加一段流式回答，卡片之间可以追问成链、多张融合、自己拉线标注关系。

答案由**当前 Harness 里配置的模型**实时生成（走 `ctx.llm.stream`），不需要额外的 API Key，也没有自己的服务端；思考结构留在画布上，而不是埋进一条越来越长的对话。

> English summary at the bottom.

## 它是什么

- 一个标准的 DSH 插件包（`dsh.bundle.patch` + `dsh.client`）：装好后左侧栏多一个图标，点开就是整块画布，占据主面板。
- **Host 半**只做一件事：注册 `/flowith-api/ask`，把 prompt 变成模型 token 流（NDJSON），顺便处理中断。
- **Client 半**是全部 UI：画布、卡片、连线、面板注册，纯 React + 原生 DOM/`fetch`，没有任何构建步骤，也不 import 任何 Harness Client 包。
- 视觉只用宿主的 `--dsw-alias-*` 主题 token，跟随明暗主题。

## 功能

- **提问**：输入问题 → 生成卡片，token 边生成边显示，推理过程以「思考中」片段出现。
- **追问**：选中一张卡片再提问，新卡片接在它后面，形成思考链。
- **融合**：⌘/Ctrl 多选 2–4 张卡片再提问，新卡片综合它们的共识、矛盾与互补。
- **关系标注**：点连线中点的「＋」，给这条关系写说明（因为 / 前提是 / 反驳 / 导致…），标注会显示在线上，也随上下文交给模型。
- **自定义连线**：拖卡片右缘的连接点到另一张卡片上，建立一条虚线关联并立刻写说明；点虚线标签可改说明或删除。它不改变父子链，但会作为「关联卡片」进入该卡片的上下文。
- **想法卡片**：切到「想法」写下自己的判断，回车存成可编辑的笔记卡（不调用模型）；选中它再提问，就是基于自己的思考发问。
- **编排**：写下目标，模型先拆 3–5 个循序渐进的子问题，再逐步执行并自动连成链路。
- **画布管理**：左上角画布名可新建、重命名、切换、删除（二次确认）；每块画布独立保存。
- **画布操作**：拖标题移动、滚轮平移、⌘/Ctrl+滚轮缩放、适应视图、自动布局、清空。
- **持久化**：内容与位置存在浏览器 `localStorage`，刷新不丢；旧的单图谱数据会自动迁移。

## 安装

仓库根目录就是一个 bundle（`package.json` + `cordis.patch.yml`）。

```sh
git clone https://github.com/pxxfrank/dsh-flowith-canvas.git
```

然后在 DSH 里用 Plugin Manager 以**本地目录**方式安装这个目录（`plugin_manager install_bundle`），或者在命令行用 DSH 的插件命令：

```sh
dsh plugin --profile <你的 profile> add ./dsh-flowith-canvas
```

安装后**刷新页面**，左侧栏会出现「思维画布」图标。改动 Host 半（`index.js`）后需要重启，或把插件先禁用再启用，才会加载新的模块。

验证环境：DSH `0.2.1-rc.2`，桌面端（desktop profile）。

## 上手

1. 空画布上直接输入问题回车，得到第一张卡片。
2. 选中它再提问 → 追问成链；⌘/Ctrl 多选两张再提问 → 融合。
3. 把卡片右缘的圆点拖到另一张卡片上 → 自己连一条线并写关系。
4. 切「编排」写下目标 → 自动拆步并逐张跑完。
5. 左上角画布名 → 新建/切换/重命名/删除画布。

## 数据流

```
Client 卡片 ──POST /flowith-api/ask {prompt, system}──▶ Host
                                                        │
                              ctx.llm.stream({provider, model, messages, system})
                                                        │
Client 卡片 ◀── NDJSON 逐行 {t:'meta'|'text'|'reason'|'finish'|'error'|'done'} ──┘
```

- 模型路由取 `agentDefaultModel.currentSelection()`，也可以在插件行的 `config` 里用 `provider` / `model` 覆盖。
- 客户端按 `requestAnimationFrame` 合帧写回，流式过程中不会逐字重渲染整个画布。
- 关掉卡片或切走画布会 abort 请求；`res` 上的错误与断流都有兜底，不会打挂 Host。

## 存储

```js
// localStorage: dsh.flowith.canvas.v2
{ version: 2, activeId: 'b1', boardSeq: 2,
  boards: [{ id, title, seq, nodes, links, createdAt, updatedAt }] }
```

```js
// 节点上的父子关系说明
node.relations = { n1: '因为' }
// 自定义连线（key 是无向去重键）
board.links = [{ key: 'n1>n3', from: 'n1', to: 'n3', label: '前提是' }]
```

回读时会校验：端点不存在的连线、自连、重复的卡片对都会被丢掉；`running` 状态的卡片降级为 `done`。

## 结构

```
dsh-flowith-canvas/
  package.json          # bundle 清单：cordis.patch.yml + dsh.client
  cordis.patch.yml      # 插入 flowith-canvas 插件行
  index.js              # Host 半：/flowith-api 流式桥，调用 ctx.llm
  client.js             # Client 半：画布页面、侧栏图标、main 面板注册
  locale/{zh,en}.json   # 插件管理页的标题与描述
  icon.svg              # 侧栏 / 插件管理图标
```

## 已知限制

- 自定义连线同一对卡片只有一条，不区分方向（方向用说明文字表达）。
- 想法卡片固定在根列创建；想让它与某张卡片相连，选中它再提问即可。
- 融合最多取 4 张父卡片，每条父结论截断到约 1400 字；关联卡片最多 3 条进 prompt。
- 编排步骤串行执行，中途不能插入人工确认。
- 清空/删除画布不可撤销，也没有导出文件。
- `/flowith-api` 不额外校验身份（只监听本机回环地址）。

## English summary

A Flowith-style node-based thinking canvas for the DeepSeek Harness Web UI, shipped as a standard DSH plugin bundle.

Every card is one question plus its streamed answer. Cards branch into follow-up chains, several cards can be fused into one synthesis, the planner splits a goal into 3–5 chained steps and runs them, and you can write your own note cards and question them. Connectors can be described ("because", "refutes", "requires"), and you can drag a card's edge port onto any other card to draw your own dashed link with a label — those labels feed back into the prompt as related cards.

The Host half only registers `/flowith-api/ask` and streams `ctx.llm.stream(...)` back as newline-delimited JSON; the Client half is plain React with no build step, no extra dependencies and no Harness Client imports. Styling uses only the host's `--dsw-alias-*` theme tokens. Model routing comes from the profile's default model, optionally overridden through the plugin row's `config`.

MIT licensed. Verified on DSH 0.2.1-rc.2 (desktop profile); no screenshots are included because the authoring environment had no browser control.
