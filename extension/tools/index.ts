// ============================================================
// extension/tools/ —— 扩展工具集（tool_set 包挂载点）
//
// 定位：可选功能扩展以 **tool_set 包**形式提供（一组 ToolCapability），
//   由 `config.extensions: string[]` 选择加载、宿主装配层（bootStem 的
//   TOOL_SETS 清单）按 id 解析注入。core 对 id 语义无感知（只透传数组），
//   `[]` = 纯 bash 最小系统。
//
// 现状（S4.2 最小变体）：参考 fs tool_set（read/write/edit/grep/glob）
//   暂驻 shell/cli/tools/（其实现基于 node fs，本就是平台层能力）；
//   本目录承接**第三方/宿主专属**工具包（如 VSCode 工具集）的落位，
//   落位后并入 bootStem 的 TOOL_SETS 清单即可被 config 选择。
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