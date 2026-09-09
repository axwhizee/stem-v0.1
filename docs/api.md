# stem 接口清单（api.md · v1.0 冻结基线）

> 与代码同批冻结（2026-09-02 定稿 v1.0；2026-09-08 身份模型换代后全表重对拍——路径 id/全局 name/信件戳 v2→v3，漂移检查脚本见 §6，记录见 docs/log2.md）。
> 机械事实来源：各模块 `index.ts` 出口 × 声明定位（脚本核对，219 符号）；
> 手工层：高价值端口语义注释、宿主注入面、HTTP API 表。
> **跨层引用铁律**：外部消费任何模块只 import 其 `index.ts`；本清单只收录公开面。
> 阅读路径建议：先看 §2 商务端口速查，再按模块翻 §1 全量清单；宿主装配见 §3。

## 1. core 模块公开面全量（十模块）


### 1.1 `config/` — 全局配置（StemConfig/解析/store 端口）（13 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `ConfigError` | `export type ConfigError =` | `src/core/config/types.ts` |
| `ConfigLoadResult` | `export interface ConfigLoadResult {` | `src/core/config/types.ts` |
| `ConfigPaths` | `export interface ConfigPaths {` | `src/core/config/store.ts` |
| `ConfigStore` — 唯一配置文件读/写端口（宿主注入） | `export interface ConfigStore {` | `src/core/config/store.ts` |
| `DEFAULT_CONFIG_TEXT` | `export const DEFAULT_CONFIG_TEXT = `{` | `src/core/config/defaults.ts` |
| `StemBashConfig` | `export interface StemBashConfig {` | `src/core/config/types.ts` |
| `StemConfig` | `export interface StemConfig {` | `src/core/config/types.ts` |
| `StemContextConfig` | `export interface StemContextConfig {` | `src/core/config/types.ts` |
| `StemProviderConfig` | `export interface StemProviderConfig {` | `src/core/config/types.ts` |
| `StemUserClass` | `export interface StemUserClass {` | `src/core/config/types.ts` |
| `defaultStemConfig` | `export function defaultStemConfig(): StemConfig {` | `src/core/config/defaults.ts` |
| `normalizeConfig` | `export function normalizeConfig(raw: Record<string, unknown>): StemConfig {` | `src/core/config/parse.ts` |
| `parseConfigText` | `export function parseConfigText(text: string, file?: string): StemConfig {` | `src/core/config/parse.ts` |

### 1.2 `context/` — 重建邮局（仓库/管理员/快递员/策略/持久端口）（53 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `AgentDelivery` | `export interface AgentDelivery {` | `src/core/context/types.ts` |
| `AppendInput` | `export interface AppendInput {` | `src/core/context/Repository.ts` |
| `AssembleInput` | `export interface AssembleInput {` | `src/core/context/types.ts` |
| `AssembleResult` | `export interface AssembleResult {` | `src/core/context/types.ts` |
| `ContextAssembler` | `export type ContextAssembler = (input: AssembleInput) => AssembleResult` | `src/core/context/types.ts` |
| `ContextManager` | `export interface ContextManager {` | `src/core/context/ContextManager.ts` |
| `ContextManagerOptions` | `export interface ContextManagerOptions {` | `src/core/context/ContextManager.ts` |
| `ContextRegistration` | `export interface ContextRegistration {` | `src/core/context/ContextManager.ts` |
| `ContextSettings` | `export interface ContextSettings {` | `src/core/context/strategies/types.ts` |
| `ContextStrategyModule` — 上下文策略契约（note/role/tools/assemble/process/actions/init） | `export interface ContextStrategyModule {` | `src/core/context/strategies/types.ts` |
| `Courier` | `export interface Courier {` | `src/core/context/Courier.ts` |
| `CourierOptions` | `export interface CourierOptions {` | `src/core/context/Courier.ts` |
| `CourierRegistration` | `export interface CourierRegistration {` | `src/core/context/Courier.ts` |
| `CourierState` | `export interface CourierState {` | `src/core/context/Courier.ts` |
| `DEFAULT_CONTEXT_SETTINGS` | `export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {` | `src/core/context/strategies/types.ts` |
| `DefaultContextManager` | `export class DefaultContextManager implements ContextManager {` | `src/core/context/ContextManager.ts` |
| `DefaultCourier` | `export class DefaultCourier implements Courier {` | `src/core/context/Courier.ts` |
| `DefaultRepository` | `export class DefaultRepository implements Repository {` | `src/core/context/Repository.ts` |
| `DefaultStrategyRegistry` | `export class DefaultStrategyRegistry implements StrategyRegistry {` | `src/core/context/strategies/registry.ts` |
| `MailDelivery` | `export type MailDelivery = AgentDelivery \| UserDelivery` | `src/core/context/types.ts` |
| `MemoryMessageStore` | `export class MemoryMessageStore implements MessageStore {` | `src/core/context/store.ts` |
| `MessageStore` — 消息 write-through 端口（同步语义，node:sqlite 实现） | `export interface MessageStore {` | `src/core/context/store.ts` |
| `PendingHold` | `export interface PendingHold {` | `src/core/context/types.ts` |
| `PersistedRepository` | `export class PersistedRepository implements Repository {` | `src/core/context/persisted.ts` |
| `Repository` | `export interface Repository {` | `src/core/context/Repository.ts` |
| `RepositoryOptions` | `export interface RepositoryOptions {` | `src/core/context/Repository.ts` |
| `RepositoryState` | `export interface RepositoryState {` | `src/core/context/types.ts` |
| `RestoredBox` | `export interface RestoredBox {` | `src/core/context/store.ts` |
| `StoredMessage` | `export interface StoredMessage {` | `src/core/context/types.ts` |
| `StrategyAgentSpec` | `export type StrategyAgentSpec = AgentClass`（类形态统一：role/worker 与用户类同形状） | `src/core/context/strategies/types.ts` |
| `StrategyApi` | `export interface StrategyApi {` | `src/core/context/strategies/types.ts` |
| `StrategyRegistry` | `export interface StrategyRegistry {` | `src/core/context/strategies/registry.ts` |
| `TimerFactory` — 计时端口（测试手动计时器注入点） | `export type TimerFactory = (fn: () => void, ms: number) => TimerHandle` | `src/core/context/Courier.ts` |
| `TimerHandle` | `export interface TimerHandle {` | `src/core/context/Courier.ts` |
| `UserDelivery` | `export interface UserDelivery {` | `src/core/context/types.ts` |
| `classicAssemble` | `export function classicAssemble(input: AssembleInput): AssembleResult {` | `src/core/context/strategies/classic.ts` |
| `createBuiltinStrategyRegistry` | `export function createBuiltinStrategyRegistry(extra: readonly ContextStrategyModule[] = []): StrategyRegistry {` | `src/core/context/strategies/index.ts` |
| `createClassicStrategy` | `export function createClassicStrategy(): ContextStrategyModule {` | `src/core/context/strategies/classic.ts` |
| `createNoneStrategy` | `export function createNoneStrategy(): ContextStrategyModule {` | `src/core/context/strategies/none.ts` |
| `createCortexStrategy` | `export function createCortexStrategy(): ContextStrategyModule {` | `src/core/context/strategies/cortex/cortex.ts` |
| `StrategyInitContext` / `StrategyInitFs` | 策略装载期契约（registerTool 窄口 + 可选 fs 写面） | `src/core/context/strategies/types.ts` |
| `CORTEX_ROLE` / `DREAMER_SPEC` | cortex 扮演面板 / dreamer 出生档案（AgentClass 形状，策略硬编码） | `src/core/context/strategies/cortex/` |
| `StrategySpawnOpts` | `export interface StrategySpawnOpts {`（spawn 回信校验/纠错循环参数：validate/maxCorrections） | `src/core/context/strategies/types.ts` |
| `estimateTokens` | `export function estimateTokens(message: ChatMessage): number {` | `src/core/context/Repository.ts` |
| `legalize` | `export function legalize(messages: readonly ChatMessage[]): ChatMessage[] {` | `src/core/context/legalize.ts` |
| `messageSeqOf` | `export function messageSeqOf(id: string): number {` | `src/core/context/store.ts` |
| `stampSender` / `formatStampAt` / `hasSenderStamp` / `SENDER_PREFIX` | 信件戳代数（B4：`<sender id="name#id" at="yymmdd.hhmm">`，打戳与格式断言唯一收口） | `src/core/context/stamp.ts` |
| `StrategyInitFs` / `StrategyLogEvent` | 策略 init 文件端口与日志事件形状 | `src/core/context/strategies/types.ts` |

### 1.3 `events/` — 事件中心（PilotEvent/EventHub）（3 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `DefaultEventHub` | `export class DefaultEventHub implements EventHub {` | `src/core/events/EventHub.ts` |
| `EventHub` — 多订阅者事件中心（shell 侧 SSE 数据源） | `export interface EventHub {` | `src/core/events/EventHub.ts` |
| `PilotEvent` | `export type PilotEvent =` | `src/core/events/types.ts` |

### 1.4 `gateway/` — 模型网关（契约 + provider 实现）（23 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `ChatMessage` | `export interface ChatMessage {` | `src/core/gateway/types.ts` |
| `ChatOptions` | `export interface ChatOptions {` | `src/core/gateway/ModelGateway.ts` |
| `ContentPart` | `export type ContentPart = TextPart` | `src/core/gateway/types.ts` |
| `FakeGateway` | `export class FakeGateway implements ModelGateway {` | `src/core/gateway/FakeGateway.ts` |
| `FakeGatewayHandler` | `export type FakeGatewayHandler = (` | `src/core/gateway/FakeGateway.ts` |
| `FinishEvent` | `export interface FinishEvent {` | `src/core/gateway/types.ts` |
| `GatewayError` | `export class GatewayError extends Error {` | `src/core/gateway/types.ts` |
| `GatewayErrorKind` | `export type GatewayErrorKind =` | `src/core/gateway/types.ts` |
| `LLMEvent` | `export type LLMEvent =` | `src/core/gateway/types.ts` |
| `LLMRequest` | `export interface LLMRequest {` | `src/core/gateway/types.ts` |
| `ModelGateway` — 宿主注入的 LLM 网关契约；chat() 流式 AsyncIterable<LLMEvent> | `export interface ModelGateway {` | `src/core/gateway/ModelGateway.ts` |
| `ModelRef` | `export interface ModelRef {` | `src/core/gateway/types.ts` |
| `OpenAiCompatibleConfig` | `export interface OpenAiCompatibleConfig {` | `src/core/gateway/providers/openaiCompatible.ts` |
| `TextPart` | `export interface TextPart {` | `src/core/gateway/types.ts` |
| `ToolCall` | `export interface ToolCall {` | `src/core/gateway/types.ts` |
| `ToolCallEvent` | `export interface ToolCallEvent {` | `src/core/gateway/types.ts` |
| `ToolDefinition` | `export interface ToolDefinition {` | `src/core/gateway/types.ts` |
| `UsageEvent` | `export interface UsageEvent {` | `src/core/gateway/types.ts` |
| `abortError` | `export function abortError(): Error & { readonly name: 'AbortError' } {` | `src/core/gateway/FakeGateway.ts` |
| `createOpenAiCompatibleGateway` | `export function createOpenAiCompatibleGateway(config: OpenAiCompatibleConfig): ModelGateway {` | `src/core/gateway/providers/openaiCompatible.ts` |
| `isAbortError` | `export function isAbortError(value: unknown): value is Error & { readonly name: 'AbortError' } {` | `src/core/gateway/types.ts` |
| `isGatewayError` | `export function isGatewayError(value: unknown): value is GatewayError {` | `src/core/gateway/types.ts` |
| `textEvents` | `export function textEvents(text: string, usage?: { inputTokens?: number; outputTokens?: number }): LLMEvent[] {` | `src/core/gateway/FakeGateway.ts` |

### 1.5 `init/` — 初始化与装配（组合根/矩阵管线/类文件双向）（23 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `AGENT_KNOWN_KEYS` | `export const AGENT_KNOWN_KEYS: ReadonlySet<string> = new Set([` | `src/core/init/agentSerialize.ts` |
| `AgentFrontmatter` | `export interface AgentFrontmatter {` | `src/core/init/agentParse.ts` |
| `ClassFs` — 类回写端口（ensureDir/writeText，进化书写面） | `export interface ClassFs {` | `src/core/init/types.ts` |
| `DiscoveredEntry` | `export interface DiscoveredEntry {` | `src/core/init/types.ts` |
| `InitDeps` | `export interface InitDeps {` | `src/core/init/types.ts` |
| `InitError` | `export type InitError =` | `src/core/init/types.ts` |
| `InitFs` — 扫描 fs 端口（listFiles/listDirs/readText） | `export interface InitFs {` | `src/core/init/types.ts` |
| `InitIssue` | `export type InitIssue =` | `src/core/init/types.ts` |
| `InitReport` | `export interface InitReport {` | `src/core/init/types.ts` |
| `InitToolLoader` — 动态 import 端口（default 导出装载，工具与策略共用） | `export interface InitToolLoader {` | `src/core/init/types.ts` |
| `ParsedAgentFile` | `export interface ParsedAgentFile {` | `src/core/init/agentParse.ts` |
| `ResourceEntry` | `export interface ResourceEntry {` | `src/core/init/types.ts` |
| `StemSystem` — createStemSystem 返回体 {kernel, pilot, tools, config, init, dispose} | `export interface StemSystem {` | `src/core/init/system.ts` |
| `StemSystemDeps` — 组合根 deps 全表（装配的唯一注入面） | `export interface StemSystemDeps {` | `src/core/init/system.ts` |
| `UserInitHook` | `export type UserInitHook = (ctx: StemSystem) => Promise<void> \| void` | `src/core/init/system.ts` |
| `agentFileName` | `export function agentFileName(name: string): string {` | `src/core/init/agentSerialize.ts` |
| `agentFileOf` | `export function agentFileOf(dir: string, name: string): string {` | `src/core/init/agentSerialize.ts` |
| `createStemSystem` | `export async function createStemSystem(deps: StemSystemDeps): Promise<StemSystem> {` | `src/core/init/system.ts` |
| `extractPrompt` | `export function extractPrompt(text: string): string {` | `src/core/init/agentParse.ts` |
| `parseAgentFile` | `export function parseAgentFile(text: string, filename: string): ParsedAgentFile {` | `src/core/init/agentParse.ts` |
| `parseFrontmatter` | `export function parseFrontmatter(text: string): Record<string, unknown> {` | `src/core/init/agentParse.ts` |
| `runInit` | `export async function runInit(deps: InitDeps): Promise<InitReport> {` | `src/core/init/init.ts` |
| `serializeAgentClass` | `export function serializeAgentClass(cls: AgentClass): string {` | `src/core/init/agentSerialize.ts` |

### 1.6 `kernel/` — 内核（Kernel/模板/实例/空间/Runtime/内置类表 builtin/agents）（37 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `AgentClass` — 类模板（name 即 id；tools Record 键即白名单；panel/custom） | `export interface AgentClass {` | `src/core/kernel/types.ts` |
| `AgentClassID` | `export type AgentClassID = string & { readonly [agentClassId]: 'AgentClassID' }` | `src/core/kernel/types.ts` |
| `AgentID` | `export type AgentID = string & { readonly [agentId]: 'AgentID' }` | `src/core/kernel/types.ts` |
| `AgentInstance` — 实例行（id = 出生路径系统托管；name 全局称呼；parentId 即族谱父；model/modelSnapshot 随行 JSON 持久） | `export interface AgentInstance {` | `src/core/kernel/types.ts` |
| `AgentInstancePatch` | `export interface AgentInstancePatch {`（name/toolOverride/model 三项可选——实例运行期唯一可写面） | `src/core/kernel/types.ts` |
| `AgentSpace` | `export interface AgentSpace {` | `src/core/kernel/types.ts` |
| `AgentSpaceID` | `export type AgentSpaceID = string & { readonly [agentSpaceId]: 'AgentSpaceID' }` | `src/core/kernel/types.ts` |
| `AgentStatus` | `export type AgentStatus =`（idle/thinking/holding/interrupted/**terminated**——terminated = 归档墓碑，只在持久层在场） | `src/core/kernel/types.ts` |
| `BUILTIN_TEMPLATES` | `export const BUILTIN_TEMPLATES: readonly AgentClass[] = [` | `src/core/kernel/Kernel.ts` |
| `ClassStore` | `export interface ClassStore {` | `src/core/kernel/Kernel.ts` |
| `DefaultInstanceManager` | `export class DefaultInstanceManager implements InstanceManager {` | `src/core/kernel/InstanceManager.ts` |
| `DefaultRuntime` | `export class DefaultRuntime implements Runtime {` | `src/core/kernel/Runtime.ts` |
| `DefaultSpaceManager` | `export class DefaultSpaceManager implements SpaceManager {` | `src/core/kernel/SpaceManager.ts` |
| `DefaultTemplateRegistry` | `export class DefaultTemplateRegistry implements TemplateRegistry {` | `src/core/kernel/TemplateRegistry.ts` |
| `InstanceManager` | `export interface InstanceManager {` | `src/core/kernel/InstanceManager.ts` |
| `InstanceStore` — 实例 write-through 端口（同上） | `export interface InstanceStore {` | `src/core/kernel/store.ts` |
| `InstantiateOptions` | `export interface InstantiateOptions {` | `src/core/kernel/InstanceManager.ts` |
| `Kernel` | `export class Kernel {` | `src/core/kernel/Kernel.ts` |
| `KernelError` | `export type KernelError =` | `src/core/kernel/types.ts` |
| `KernelOptions` | `export interface KernelOptions {` | `src/core/kernel/Kernel.ts` |
| `ModelBinding` | `export interface ModelBinding {` | `src/core/kernel/types.ts` |
| `ModelOrigin` | `export type ModelOrigin =` | `src/core/kernel/types.ts` |
| `PersistedInstanceManager` | `export class PersistedInstanceManager implements InstanceManager {` | `src/core/kernel/persisted.ts` |
| `PersistedSpaceManager` | `export class PersistedSpaceManager implements SpaceManager {` | `src/core/kernel/persisted.ts` |
| `ProjectRef` | `export type ProjectRef = string` | `src/core/kernel/types.ts` |
| `Runtime` | `export interface Runtime {` | `src/core/kernel/Runtime.ts` |
| `SpaceManager` | `export interface SpaceManager {` | `src/core/kernel/SpaceManager.ts` |
| `TemplateRegistry` | `export interface TemplateRegistry {` | `src/core/kernel/TemplateRegistry.ts` |
| `USER_CLASS_ID` | `export const USER_CLASS_ID = makeAgentClassID('user')` | `src/core/kernel/types.ts` |
| `ROOT_ID` / `ROOT_NAME` | `export const ROOT_ID = makeAgentID('0')` / `export const ROOT_NAME = 'user'`（根出生路径 id 与缺省称呼，全名 user#0） | `src/core/kernel/types.ts` |
| `formatFull` | `export function formatFull(name: string, agentId: AgentID \| string): string`（呈现面统一 `name#id`） | `src/core/kernel/types.ts` |
| `parentIdOf` / `AGENT_ID_PATTERN` | 路径父纯推导（去尾段）/ id 合法形 `/^\d+(-\d+)*$/` | `src/core/kernel/types.ts` |
| `ResolveResult` | `export type ResolveResult =`（寻址三形态解析结果：found/ambiguous/notFound） | `src/core/kernel/InstanceManager.ts` |
| `createSystemTools` | `export function createSystemTools(kernel: Kernel): ToolCapability[] {` | `src/core/kernel/systemTools.ts` |
| `buildUserClass` / `USER_DEFAULT` / `ASSISTANT` / `BUILTIN_AGENT_CLASSES` / `UserClassConfig` | 内置类唯一定义域（user 默认档 + assistant 白纸；根称呼经 UserClassConfig.name 注入） | `src/core/kernel/builtin/agents.ts` |
| `makeAgentClassID` | `export function makeAgentClassID(id: string): AgentClassID {` | `src/core/kernel/types.ts` |
| `makeAgentID` | `export function makeAgentID(id: string): AgentID {` | `src/core/kernel/types.ts` |
| `makeAgentSpaceID` | `export function makeAgentSpaceID(id: string): AgentSpaceID {` | `src/core/kernel/types.ts` |

### 1.7 `lineage/` — 族谱树（拓扑/能力物化/模型相/可见域）（13 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `AccessBindEntry` | `export interface AccessBindEntry {`（steps 元素 = ConvergenceStep {list, mode?}——raise 步为策略声明清单） | `src/core/lineage/AccessLedger.ts` |
| `AccessBindMode` | `export type AccessBindMode = 'inherit' \| 'grant'` | `src/core/lineage/AccessLedger.ts` |
| `AccessLedger` | `export interface AccessLedger {` | `src/core/lineage/AccessLedger.ts` |
| `AccessProfile` | `export interface AccessProfile {` | `src/core/lineage/AccessLedger.ts` |
| `DefaultAccessLedger` | `export class DefaultAccessLedger implements AccessLedger {` | `src/core/lineage/AccessLedger.ts` |
| `DefaultLineageTree` | `export class DefaultLineageTree implements LineageTree {` | `src/core/lineage/LineageTree.ts` |
| `LineageBindEntry` | `export interface LineageBindEntry extends AccessBindEntry {` | `src/core/lineage/LineageTree.ts` |
| `LineageTree` — 族谱树门面：attach/detach/replay + effectiveAccess + modelOf/nodeConfigOf + canReach（无直改口，变更=replay） | `export interface LineageTree {` | `src/core/lineage/LineageTree.ts` |
| `LineageTreeOptions` | `export interface LineageTreeOptions {` | `src/core/lineage/LineageTree.ts` |
| `ModelBindInput` | `export interface ModelBindInput {` | `src/core/lineage/LineageTree.ts` |
| `ModelBinding` | `export interface ModelBinding {` | `src/core/kernel/types.ts` |
| `ModelOrigin` | `export type ModelOrigin =` | `src/core/kernel/types.ts` |
| `NodeConfig` | `export interface NodeConfig {` | `src/core/lineage/LineageTree.ts` |

### 1.8 `logging/` — 结构化日志（LogEvent/Logger/LogSink）（22 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `AccessAsked` | `export interface AccessAsked {` | `src/core/logging/events.ts` |
| `AccessReplied` | `export interface AccessReplied {` | `src/core/logging/events.ts` |
| `AgentClassRegistered` | `export interface AgentClassRegistered {` | `src/core/logging/events.ts` |
| `AgentClassUpdated` | `export interface AgentClassUpdated {` | `src/core/logging/events.ts` |
| `AgentInstanceCreated` | `export interface AgentInstanceCreated {` | `src/core/logging/events.ts` |
| `AgentInterrupted` | `export interface AgentInterrupted {` | `src/core/logging/events.ts` |
| `AgentMessageSent` | `export interface AgentMessageSent {` | `src/core/logging/events.ts` |
| `AgentStatusChanged` | `export interface AgentStatusChanged {` | `src/core/logging/events.ts` |
| `AgentTerminated` | `export interface AgentTerminated {` | `src/core/logging/events.ts` |
| `ApiRequestRecorded` | `export interface ApiRequestRecorded {` | `src/core/logging/events.ts` |
| `ContextAssembled` | `export interface ContextAssembled {` | `src/core/logging/events.ts` |
| `InMemoryLogger` | `export class InMemoryLogger implements Logger {` | `src/core/logging/Logger.ts` |
| `LogEvent` | `export type LogEvent =` | `src/core/logging/events.ts` |
| `LogFilter` | `export interface LogFilter {` | `src/core/logging/Logger.ts` |
| `LogSink` | `export interface LogSink {` | `src/core/logging/Logger.ts` |
| `Logger` | `export interface Logger extends LogSink {` | `src/core/logging/Logger.ts` |
| `MailboxCountdown` | `export interface MailboxCountdown {` | `src/core/logging/events.ts` |
| `MailboxDelivered` | `export interface MailboxDelivered {` | `src/core/logging/events.ts` |
| `ToolInvoked` | `export interface ToolInvoked {` | `src/core/logging/events.ts` |
| `eventInvolvesAgent` | `export function eventInvolvesAgent(event: LogEvent, agentId: string): boolean {` | `src/core/logging/Logger.ts` |
| `forget` | `export function forget(promise, site, sink)`（孤儿 promise 安全阀——高价值端口） | `src/core/logging/forget.ts` |
| `KernelOrphanError` | `export interface KernelOrphanError {`（孤儿 promise 落账事件） | `src/core/logging/events.ts` |

### 1.9 `pilot/` — Pilot（根 user#0 扮演接口）（4 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `DefaultPilot` | `export class DefaultPilot implements Pilot {` | `src/core/pilot/Pilot.ts` |
| `Pilot` — 根扮演接口（sendMessage/instantiate(model/name 可选)/setModel/replyAccess/runContextAction/subscribe） | `export interface Pilot {` | `src/core/pilot/Pilot.ts` |
| `PilotOptions` | `export interface PilotOptions {` | `src/core/pilot/Pilot.ts` |
| `createPilot` | `export async function createPilot(options: PilotOptions): Promise<Pilot> {` | `src/core/pilot/Pilot.ts` |

### 1.10 `tools/` — 工具体系（注册表/访问四态/ask 消息化/bash）（43 项）

| 符号 | 声明 | 位置 |
|---|---|---|
| `AccessAskBus` | `export interface AccessAskBus {` | `src/core/tools/accessRequest.ts` |
| `AccessAskOptions` | `export interface AccessAskOptions {` | `src/core/tools/accessRequest.ts` |
| `AccessAssertInput` | `export interface AccessAssertInput {` | `src/core/tools/types.ts` |
| `AccessError` | `export type AccessError =` | `src/core/tools/types.ts` |
| `AccessReply` | `export type AccessReply = 'once' \| 'always' \| 'reject'` | `src/core/tools/types.ts` |
| `AccessReplyInput` | `export interface AccessReplyInput {` | `src/core/tools/types.ts` |
| `AccessRequest` | `export interface AccessRequest {` | `src/core/tools/types.ts` |
| `AccessResolver` — tools 侧权限查询端口（族谱台账供给，无判定落默认） | `export interface AccessResolver {` | `src/core/tools/types.ts` |
| `BASH_DEFAULTS` | `export const BASH_DEFAULTS = {` | `src/core/tools/bash.ts` |
| `BashToolSettings` | `export interface BashToolSettings {` | `src/core/tools/bash.ts` |
| `DefaultAccessAskBus` | `export class DefaultAccessAskBus implements AccessAskBus {` | `src/core/tools/accessRequest.ts` |
| `DefaultToolCapabilityRegistry` | `export class DefaultToolCapabilityRegistry implements ToolCapabilityRegistry {` | `src/core/tools/ToolCapabilityRegistry.ts` |
| `ShellRunOptions` | `export interface ShellRunOptions {` | `src/core/tools/bash.ts` |
| `ShellRunResult` | `export interface ShellRunResult {` | `src/core/tools/bash.ts` |
| `ShellRunner` — bash 执行端口（宿主注入，core 零平台依赖关键） | `export interface ShellRunner {` | `src/core/tools/bash.ts` |
| `ToolAccess` | `export type ToolAccess = 'allow' \| 'ask' \| 'deny' \| 'ignore'` | `src/core/tools/types.ts` |
| `ToolAccessRule` | `export interface ToolAccessRule {` | `src/core/tools/types.ts` |
| `ToolAccessRules` | `export type ToolAccessRules = readonly ToolAccessRule[]` | `src/core/tools/types.ts` |
| `ToolCapability` — 工具统一形状：id/description/parameters/execute/init?/kind/accessKey | `export interface ToolCapability {` | `src/core/tools/types.ts` |
| `ToolCapabilityRegistry` | `export interface ToolCapabilityRegistry {` | `src/core/tools/ToolCapabilityRegistry.ts` |
| `ToolCategory` | `export type ToolCategory =` | `src/core/tools/types.ts` |
| `ToolContext` — 执行上下文 {agentId, spaceId, signal?, callId?}（权限层不随身传） | `export interface ToolContext {` | `src/core/tools/types.ts` |
| `ToolError` | `export type ToolError =` | `src/core/tools/types.ts` |
| `ToolHooks` | `export interface ToolHooks {` | `src/core/tools/types.ts` |
| `ToolInitContext` — 工具 init 生命周期注入面（fs/projectRoot/log） | `export interface ToolInitContext {` | `src/core/tools/types.ts` |
| `ToolInitFs` | `export interface ToolInitFs {` | `src/core/tools/types.ts` |
| `ToolInvocation` | `export interface ToolInvocation {` | `src/core/tools/types.ts` |
| `ToolKind` | `export type ToolKind = 'internal' \| 'extension' \| 'custom'` | `src/core/tools/types.ts` |
| `ToolListFilter` | `export interface ToolListFilter {` | `src/core/tools/ToolCapabilityRegistry.ts` |
| `ToolParametersSchema` | `export interface ToolParametersSchema {` | `src/core/tools/types.ts` |
| `ToolPropertySchema` | `export interface ToolPropertySchema {` | `src/core/tools/types.ts` |
| `ToolRecord` | `export interface ToolRecord {` | `src/core/tools/types.ts` |
| `ToolReference` | `export interface ToolReference {` | `src/core/tools/types.ts` |
| `ToolRegistryOptions` | `export interface ToolRegistryOptions {` | `src/core/tools/ToolCapabilityRegistry.ts` |
| `ToolResult` | `export interface ToolResult {` | `src/core/tools/types.ts` |
| `createBashTool` | `export function createBashTool(deps: {` | `src/core/tools/bash.ts` |
| `formatAccessRequest` | `export function formatAccessRequest(request: AccessRequest): string {` | `src/core/tools/accessRequest.ts` |
| `formatShellOutput` | `export function formatShellOutput(` | `src/core/tools/bash.ts` |
| `restrictAccess` | `export function restrictAccess(a: ToolAccess, b: ToolAccess): ToolAccess {` | `src/core/tools/access.ts` |
| `accessRank` / `checkToolsConvergence` | 总序数值 + 清单收敛校验（类书写/实例更新共用） | `src/core/tools/access.ts` |
| `validateArgs` | `export function validateArgs(input: unknown, schema: ToolParametersSchema): string \| undefined {` | `src/core/tools/validate.ts` |

| `foldConvergenceSteps` | `export function foldConvergenceSteps(parentExplicit, caps, steps)`（收敛链单一代数：物化钳制/写入拒绝共用；steps 三元组含 mode——replace 白名单整表 / raise 只抬不封） | `src/core/tools/access.ts` |
| `checkToolsConvergence` | `export function checkToolsConvergence(`（类书写面纯校验：violation 字符串清单） | `src/core/tools/access.ts` |
| `ConvergenceLayer` / `ConvergenceViolation` | 层名四元（根/类/策略/实例收敛）与违例形状 | `src/core/tools/access.ts` |

## 2. 高价值端口速查（开发者最常触碰）

| 端口 | 契约要点 | 注入方 |
|---|---|---|
| `ModelGateway` | `chat(req, {signal}) → AsyncIterable<LLMEvent>`；usage 事件承载真实 token（T3 计量源头） | 宿主 `buildGateway(config, env)`（providers 路由，两段式 warn/硬错） |
| `MessageStore` / `InstanceStore` | **同步** write-through 端口（对齐 DatabaseSync；close? 收尾） | `shell/cli/storage.createSqliteStateStore` |
| `ConfigStore` / `InitFs` / `InitToolLoader` / `ClassFs` | 配置读写、目录扫描（listFiles/listDirs/readText）、动态 import、类落盘 | `shell/cli/config.createNodeConfigBundle` |
| `ShellRunner` | bash 工具执行端口（超时/截断参数在 core 侧，进程在宿主） | `shell/cli/bash.createNodeShellRunner` |
| `ToolCapability` | 工具统一形状 + `init?(ToolInitContext)` 生命周期；kind 三分类（internal/extension/custom） | registry.register / runInit 矩阵装载 |
| `ContextStrategyModule` | note/role/tools/assemble/process/actions/init 七面（tools = 声明清单 raise 步）；注册同名覆盖内置；init 先于工具 initAll（registerTool 窄口注策略自带工具，出生恒 ignore） | 策略注册表 / `.stem/context/` / extension 点名 |
| `LineageTree` | 权限与模型的唯一门面：attach/detach/replay、effectiveAccess、modelOf、nodeConfigOf、canReach（能力面无直改 setter；运行期变更 = kernel.updateAgent 写行后全树 replay，快照层保证改父不动子） | Kernel 内部（tools 经 AccessResolver 查询） |
| `Pilot` | 根扮演接口（一切外部驱动经它）：sendMessage/instantiate(model/name 可选)/setModel/replyAccess/runContextAction/subscribe | 各 shell |
| `EventHub`/`PilotEvent` | stream/letter/status/notice 判别联合，多订阅者（SSE 直转） | `system.pilot.subscribe` |

## 3. 装配与矩阵装载（宿主侧）

| 入口 | 位置 | 说明 |
|---|---|---|
| `createStemSystem(deps: StemSystemDeps): Promise<StemSystem>` | `src/core/init` | 组合根；deps 面：config(store+paths)/fs/tools(loader)/gateway/logger?/timer?/maxSteps?/estimateCost?/hostTools?/extensionRoots?/shellRunner?/classFs?/userHooks?/onEvent?/stateStore? |
| `runInit(deps: InitDeps): Promise<InitReport>` | `src/core/init` | 三维矩阵统一装载（internal→extension→custom，后层同名覆盖）；DEFAULT_EXTENSION_TOOLS=fs 五件套 |
| `bootStem(opts: BootOptions): Promise<BootResult>` | `shell/cli/platform` | 参考 shell 装配（网关路由+SQLite+bash+extension 根）；`extensionRoots()` 给出仓库三根 |
| `buildGateway(config, env)` | `shell/cli/gateway` | providers 注册表 → ModelGateway 路由门面（R1 两段式） |
| `createSqliteStateStore(file)` | `shell/cli/storage` | 两端口 + close（user_version v3：版本不符 = 拒载硬错零兼容） |

## 4. 文件契约（用户主权面）

| 路径 | 形状 | 装载 |
|---|---|---|
| `.stem/stem.jsonc` | StemConfig（R12 全量有效，未知顶层键 fail-fast；providers/user.model 必填） | ConfigStore |
| `.stem/tools/<名>/<名>.ts`（兼容平铺 `.ts`） | default: ToolCapability（kind 强制 custom） | runInit custom 层 |
| `.stem/agent/<名>/<名>.md`（兼容平铺） | YAML frontmatter（tools 键即白名单；context_strategy/model/send_countdown；未知透传 custom）+ 正文=systemPrompt | runInit / ClassStore 回写 |
| `.stem/context/<名>.ts` | default: ContextStrategyModule（同名覆盖内置） | runInit |
| `.stem/tools/skill/<技能>/SKILL.md` | YAML name/description + 正文（opencode/claude 兼容） | custom 装载器约定（无系统机制） |
| `extension/{tools,agent,context}/<名>/<名>.<ext>` | 同上三类（extension 层唯一形态；default 可工厂 `(projectRoot)=>X`；`_` 前缀目录=非资源） | config.extensions 点名 |
| `.stem/stem.db` | messages/instances/spaces 三表（行=记录全量 JSON；agent_id/seq/archived 冗余列） | write-through / dashboard 直读 |

## 5. HTTP API（shell 层）

### 5.1 WebUIShell（:4321，交互面）

| 方法 路径 | 语义 |
|---|---|
| GET `/api/health` | 探针（ok/gateway/agents）——docker HEALTHCHECK |
| GET `/api/events` | SSE（PilotEvent 五元流：stream/letter/status/tool/notice） |
| GET `/api/agents` | 第一视角行集（id/name/status/turnCount/totalTokens/strategy/ctxTokens/lastActive/model+modelOrigin/lastPrompt） |
| GET `/api/templates` / `/api/models` | 类清单 / 模型候选（providers 白名单展开） |
| GET `/api/agents/:id/context` | 行级语料（role/tag/tokens/**at**/turn/valid + `contextWindow` 占用分母） |
| POST `/api/send` `{to,text}` | 扮演根送信 |
| POST `/api/instantiate` `{className,userPrompt,model?,name?}` | 建实例（model=显式层出生；name=出生称呼） |
| POST `/api/terminate` `{agentId,recursive?}` / `/api/interrupt` `{agentId}` | 销毁（canReach）/ 当前轮中断 |
| POST `/api/set_model` `{agentId,model}` | 模型热切换（不级联子女） |
| POST `/api/update` `{agentId,name?}` | 实例参数写口（改名；kernel.updateAgent 宿主信任通道，by 缺省） |
| POST `/api/access` `{requestId,reply,message?}` | ask 答复（once/always/reject） |
| POST `/api/context_action` `{agentId,action,...}` | 上下文策略动作面（compact 等） |
| GET `/`、`/style.css`、`/app.js`、`/view.js` | 单页 UI 三件套（html/css/js 分文件）+ 双端共用纯函数核心 |

### 5.2 Dashboard（:4421，法医/管理员面）

| 方法 路径 | 语义 |
|---|---|
| GET `/api/health` | ok/project/db 存在/allowWrite |
| GET `/api/stats` · `/api/agents` · `/api/tokens` | 汇总四卡 / 族谱行集（view.js 兼容） / token 账目（byAgent 角色·tag、byDay） |
| GET `/api/messages?agentId&limit&offset&archived=1` | 语料分页预览 |
| GET `/api/raw?table=messages\|instances\|spaces` | 原表 JSON 直读 |
| GET `/api/inventory?refresh=1` | 三态资源标本（tools/classes/providers/homeModel/initIssues） |
| GET `/api/cleanup/preview` | 垃圾与可回收量预览 |
| POST `/api/cleanup` `{action,confirm:'yes',agentId?,force?}` | gc-orphans / gc-terminated / purge-agent / vacuum（`--allow-write` 门禁） |

## 6. 校验脚本（对拍保真，禁手工漂移）

```bash
# 任一符号在 index 出口消失或声明漂移即报出：
grep -rhoE 'export (interface|type|class|const|function) [A-Za-z_]+' src/core --include='*.ts' | sort | uniq
```
