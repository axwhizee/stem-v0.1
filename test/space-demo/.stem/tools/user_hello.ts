// ============================================================
// 用户工具示例（.stem/tools/）—— 默认导出 ToolCapability 对象
//
// init 动态 import 后读取 default 注册；kind 强制为 'custom'（S7 矩阵）。
// 权限名缺省 = 工具 id；此处显式声明 permission: 'read'。
// ============================================================

import type { ToolCapability } from '../../../src/core/tools'

const helloUserTool: ToolCapability = {
  id: 'user_hello',
  description: '问候工具：返回一条友好问候（用户工具示例）。',
  permission: 'read',
  category: 'business',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '要问候的名字（可选）' },
    },
  },
  execute: (input: unknown) => {
    const { name } = (input ?? {}) as { name?: string }
    return { text: `你好，${name ?? '朋友'}！这是来自 .stem/tools/ 的用户工具。` }
  },
}

export default helloUserTool
