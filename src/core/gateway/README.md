# gateway —— 模型网关契约 + provider 实现

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。

## 职责

- 定义模型访问契约 `ModelGateway`（`chat(request, {signal}) → AsyncIterable<LLMEvent>`）。
- 提供 OpenAI 兼容 provider 实现（`providers/openaiCompatible.ts`）与测试用 `FakeGateway`。
- 领域类型 `ChatMessage`/`LLMRequest`/`LLMEvent`/`UsageEvent`/`ModelRef` + 错误判别联合（`GatewayError`/`isGatewayError`/`isAbortError`）。

## 文件

| 文件 | 内容 |
|---|---|
| `ModelGateway.ts` | 接口与默认实现约定 |
| `types.ts` | LLM 协议中立形状 + 错误联合 |
| `providers/openaiCompatible.ts` | OpenAI 兼容 SSE 客户端（`fetch?` 传输口可注入） |
| `FakeGateway.ts` | 单测/冒烟假网关（可注 usage） |

## 纪律

- **零端点常量**：provider 的 base_url/key 全部来自 `config.providers`；core 不认厂商。
- 厂商适配（UA、session 头等）只准住 `shell/cli/gateway.ts`，core 零感知。
- 流式一律 `AsyncIterable`，消费方 `for await` + AbortSignal。

## 依赖

叶子（**无 core 依赖**）。
