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
