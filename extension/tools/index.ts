// ============================================================
// extension/tools/ —— 扩展工具集（预留位，未实现迁移）
//
// 定位：可选的第三方/宿主工具集扩展挂载点。当前 fs 工具集
// （read/write/edit/grep/glob）仍作为 cli 参考 shell 的默认装载，
// 后续按需迁移至此，且可用其它工具集（如 VSCode 工具集）替换。
//
// seam 签名（约定，未实现）：
//   registerExtensionTools(registry: ToolCapabilityRegistry): Promise<void>
//   —— 由各 shell 在 bootStem 的 hostTools 位置挂载（或经 userHooks 注册）。
//
// skill / MCP 属于 core 生态（上下文组装 + 配置目录解析），不在本目录。
// ============================================================

export type { ToolCapabilityRegistry } from '../../src/core/tools'

/**
 * 扩展工具集注册入口（约定签名）。将本目录下的工具注册进 registry。
 * 未来实现：扫描 `extension/tools/*.ts` 或按清单显式注册。
 */
export async function registerExtensionTools(_registry: import('../../src/core/tools').ToolCapabilityRegistry): Promise<void> {
  // 预留：暂无内置扩展工具集。
  void _registry
}