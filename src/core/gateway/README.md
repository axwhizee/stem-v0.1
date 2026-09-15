# gateway —— 模型网关契约 + provider 实现

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。

## 职责

- 定义模型访问契约 `ModelGateway`（`chat(request, {signal}) → AsyncIterable<LLMEvent>`）。
- 提供 OpenAI 兼容 provider 实现（`providers/openaiCompatible.ts`）与测试用 `FakeGateway`。
- 领域类型 `ChatMessage`/`LLMRequest`/`LLMEvent`/`UsageEvent`/`ModelRef`/`EffortLevel`/`ModelOrigin`/`ModelBinding` + `parseModelRef`（`提供商/模型` 单一解析点）+ 错误判别联合（`GatewayError`/`isGatewayError`/`isAbortError`）。

## 文件

| 文件 | 内容 |
|---|---|
| `ModelGateway.ts` | 接口与默认实现约定 |
| `types.ts` | LLM 协议中立形状 + 错误联合 |
| `providers/openaiCompatible.ts` | OpenAI 兼容 SSE 客户端（`fetch?` 传输口可注入） |
| `FakeGateway.ts` | 单测/冒烟假网关（可注 usage） |

## provider 与路由

- `openaiCompatible` 泛化单点：`{baseUrl(必填), apiKey?(缺省=匿名不发 Authorization), models?(白名单请求前硬拦), fetch?}`，POST `{base_url}/chat/completions` 恒发裸模型 id，解析 reasoning_content → reasoning-delta。**代码零端点常量、零 `process.env`**——端点/密钥全由宿主从 `config.providers` 注入。错误分类含 `provider_unwired`/`model_not_allowed`。
- **路由在宿主门面**（`shell/cli/gateway.buildGateway(config, env)`）：逐 provider 装配 + 按 `req.model.provider` 分发；两段式 = key_env 未命中启动 warn 点名（不印值）+ 用到才硬错（零兜底；产品无 mock 回落）。
- **并行工具调用**：协议层 `tool_calls` 数组原生支持；工具轮并行执行，结果按 index 回填（Runtime 侧）。

## 纪律

- **零端点常量**：provider 的 base_url/key 全部来自 `config.providers`；core 不认厂商。
- 厂商适配（UA、session 头等）只准住 `shell/cli/gateway.ts`，core 零感知。
- 流式一律 `AsyncIterable`，消费方 `for await` + AbortSignal。

## 依赖

叶子（**无 core 依赖**）。
