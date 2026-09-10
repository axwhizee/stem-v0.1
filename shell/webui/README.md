# shell/webui —— WebUIShell（HTTP + SSE + 单页 UI）

> 第一视角浏览器交互：`node:http` + SSE，复用 cli 的 `bootStem` 装配。
> 定位见 `docs/architecture.md` 4.13。

## 职责

- **服务端 `server.ts`**：`node:http` + SSE（`/api/events`，`/api/health` 供容器 HEALTHCHECK），REST 面（agents/instantiate/send/context/…）。复用 `shell/cli/platform.bootStem`，只做 HTTP/UI。
- **前端三件套**（零构建，经 sendStatic 直发）：`index.html`（纯结构）/ `style.css`（主题）/ `app.js`（模块脚本）+ `view.js`（纯函数核心，`view.d.ts` 类型、`view.test.ts` node 直测）。
- **订阅面**：`pilot.subscribe` 消费 PilotEvent（stream/letter/status/tool/notice）→ SSE 推送到浏览器。

## UI 结构（OLED 无边框主题）

- **左栏四段**：标题行（族谱 / `設` 设置面板 / `隠` 收起）/ 族谱树（出生路径 id 自然序、状态字前置、悬浮详情卡与数据同源、当前对话高亮、「選」钮浮动零占位）/ 实例化面板 / 快捷设置（当前 agent 模型环 + 思考程度占位）。
- **主区无 header**：timeline + composer（opencode 风容器：输入框在上；下行 = 附钮 · **六项信息条**（全名/模型/策略/轮次/上下文/累计）· 状态字+连接点右置 · 送钮）+ 铺底占用条（三色带 <20/20-40/>40%）。
- **二级操作菜单**（树行「選」/右击：对话/监督/中断/压缩/改名/实例配置/类配置/销毁，状态由 `deriveActions` 数据驱动）与**设置面板**（模态双页签）承接全部动作，左栏不再常驻信息卡。
- 消息 hover 复制「複」+ 尾条最近一轮耗时；权限弹窗 = 渲染 `<access_request>` + `access_reply`。

## 流式 live 层（`view.js` 纯函数）

- `applyStreamEvent` 分桶 reducer——delta live-only、轮末快照收口不补间隙；`reasoningView` 思维链折叠（running 追最新 / 结束定格首行，summary 与 rest 零重复）；工具 chip 三态（无 args，耗时 called→success 相减）；`contextRatio/ratioTone`；`mdToHtml` 零依赖 markdown 子集（先抽码后转义）；rAF 合帧节流 + 监督抽屉。
- **绑定地址**：裸机缺省 `127.0.0.1`，容器 `STEM_HOST=0.0.0.0`。

## 文件

| 文件 | 内容 |
|---|---|
| `server.ts` | HTTP + SSE 服务端（REST/静态/事件流） |
| `index.html` / `style.css` / `app.js` | 单页前端三件套 |
| `view.js` / `view.d.ts` / `view.test.ts` | 纯函数视图核心 + 类型 + 单测 |
