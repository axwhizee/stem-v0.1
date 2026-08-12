// ============================================================
// shell/tools/index.ts —— host 内置工具（kind=shell）装配
//
// 与 core 解耦的文件系统工具，经 registry 注册接口接入（未来
// MCP / VSCode 等宿主工具同样通过该接口注册）。
// ============================================================

import type { ToolCapability } from '../../src/core/tools'
import { createReadTool } from './read'
import { createWriteTool } from './write'
import { createEditTool } from './edit'
import { createGrepTool } from './grep'
import { createGlobTool } from './glob'

/** 生成 host 外部工具清单（基于工作区根路径）。 */
export function createHostTools(root: string): ToolCapability[] {
  return [
    createReadTool(root),
    createWriteTool(root),
    createEditTool(root),
    createGrepTool(root),
    createGlobTool(root),
  ]
}

export { globToRegExp, resolvePath } from './fs-util'
export type { GrepMatch } from './grep'
