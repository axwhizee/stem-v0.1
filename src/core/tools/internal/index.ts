// ============================================================
// core/tools/internal/index.ts —— internal 工具唯一定义域
//
// `createInternalTools` 是 internal 工具的**唯一出入口**：注入 SystemToolHost
// （按域窄端口）与可选 bash 端口，产出全部 kind=internal 工具。组合根负责接线。
// ============================================================

import type { ToolCapability } from '../types'
import type { SystemToolHost } from './ports'
import { createSystemTools } from './systemTools'
import type { BashToolSettings, ShellRunner } from './bash'
import { createBashTool } from './bash'

export interface InternalToolDeps {
  readonly host: SystemToolHost
  /** bash 端口（宿主注入 ShellRunner 才装配；core 零平台依赖）。 */
  readonly bash?: { readonly runner: ShellRunner; readonly settings?: BashToolSettings }
}

/** internal 工具唯一出入口：系统工具 + （可选）bash。 */
export function createInternalTools(deps: InternalToolDeps): ToolCapability[] {
  return [
    ...createSystemTools(deps.host),
    ...(deps.bash !== undefined ? [createBashTool(deps.bash)] : []),
  ]
}

export { createSystemTools } from './systemTools'
