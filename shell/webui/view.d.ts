// ============================================================
// shell/webui/view.d.ts —— view.js 的类型声明（实现零依赖纯 JS，
// 浏览器直用；node:test 与 server 侧 TS 经此声明获得类型）。
// ============================================================

export declare const ROOT_ID: string

export declare const STATUS_GLYPH: Record<string, string>
export declare const ACT_GLYPH: Record<string, string>

export declare function statusGlyph(status: string): string
export declare function statusTone(status: string): 'active' | 'alert' | 'ready'

export interface SenderParts {
  sender: string
  text: string
}
export declare function stripSender(raw: unknown): SenderParts
export declare function truncate(text: unknown, max?: number): string

export interface ContextMessage {
  role?: string
  content?: unknown
  tag?: string
  from?: string
  valid?: boolean
}

export interface TimelineItem {
  kind: 'msg' | 'tool' | 'meta' | 'ask'
  side?: 'me' | 'agent' | 'them'
  who?: string
  text: string
  icon?: string
}
export declare function routeLetters(messages: ContextMessage[] | undefined, currentId: string, rootId?: string): TimelineItem[]

export interface AgentRow {
  id: string
  parentId: string | null
  name?: string
  classRef?: string
  status?: string
  lastPrompt?: string
  model?: string
  modelOrigin?: string
  [key: string]: unknown
}

export type TreeRow =
  | {
      type: 'node'
      id: string
      isRoot: boolean
      depth: number
      lane: number
      parentLane: number | null
      join: boolean
      passThrough: number[]
      family: number
      row: AgentRow
    }
  | {
      type: 'more'
      kind: 'depth' | 'siblings'
      count: number
      descendants?: number
      depth: number
      lane: number
    }

export declare const FAMILY_PALETTE: string[]
export declare function computeTreeRows(agents: AgentRow[], opts?: { maxDepth?: number; maxSiblings?: number; rootId?: string }): TreeRow[]

export type ActionState = 'off' | 'ready' | 'active'
export interface ActionStates {
  send: ActionState
  interrupt: ActionState
  compact: ActionState
  terminate: ActionState
  model: ActionState
}
export declare function deriveActions(agent: { id?: string; parentId?: string | null } | null | undefined): ActionStates

// ---------- 流式 live 桶（SSE PilotEvent JSON 形就地消费） ----------

export interface LiveTool {
  name: string
  phase: 'called' | 'success' | 'error'
  at: number
  doneAt: number
}
export interface LiveBucket {
  text: string
  reasoning: string
  tools: LiveTool[]
  startedAt: number
  lastAt: number
}
export type LiveBuckets = Record<string, LiveBucket>

/** SSE PilotEvent 的最小结构面（reducer 只认这四型字段）。 */
export interface StreamEventLike {
  type?: string
  agentId?: string
  event?: { type?: string; text?: string }
  tool?: string
  phase?: string
  at?: number
  letters?: unknown
  from?: string
  to?: string
  message?: string
}

export declare function createLiveBuckets(): LiveBuckets
export declare function applyStreamEvent(buckets: LiveBuckets, ev: StreamEventLike | null | undefined): LiveBuckets
export declare function clearBucket(buckets: LiveBuckets, agentId: string): void

export interface ReasoningView {
  summary: string
  /** 去掉摘要行的正文（折叠头与展开内容零重复）。 */
  rest: string
}
export declare function reasoningView(text: string, running: boolean): ReasoningView | null

export declare function contextRatio(messages: Array<{ tokens?: number; valid?: boolean }> | undefined, window: number | undefined): number
export declare function ratioTone(ratio: number): 'ok' | 'warn' | 'danger'

export declare function mdToHtml(raw: unknown): string

// ---------- 批 3：族谱排序 / 二级菜单 / 信息卡 / 统计 ----------

export declare function idOrder(a: string, b: string): number

export interface MenuItem {
  key: string
  label: string
  state: ActionState
  danger?: boolean
}
export declare function menuItems(agent: AgentRow | null | undefined): MenuItem[]

export interface InfoRow {
  k: string
  v: string
}
export declare function infoRows(agent: AgentRow | null | undefined, now?: number): InfoRow[]
export declare function composerMeta(agent: AgentRow | null | undefined): InfoRow[]

export declare function relativeTime(ts: number, now?: number): string

export interface TurnStats {
  tokens: number
  turns: number
  durationS: number
  firstAt: number
  lastAt: number
}
export declare function turnStats(messages: Array<{ valid?: boolean; tokens?: number; turn?: number; at?: number; role?: string }> | undefined): TurnStats
