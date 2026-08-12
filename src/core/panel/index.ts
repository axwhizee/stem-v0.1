// ============================================================
// core/panel/index.ts —— 唯一出口
// ============================================================

export type {
  LetterPanelMessage,
  PermissionPanelMessage,
  NoticePanelMessage,
  PanelMessage,
  PanelConsumer,
} from './types'

export type { PanelBusOptions, PanelBus } from './PanelBus'
export { DefaultPanelBus } from './PanelBus'
