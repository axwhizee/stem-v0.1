// ============================================================
// core/kernel/userClass.ts —— 内置 user 类（系统根模板）
//
// user0 = user 类的普通实例（parentId=null 即根），无任何特判。
// 类配置承载系统初始权限：tools = config 中工具权限设置（permission），
// 后续按族谱树逐层收敛（祖先链 → 类清单 → session）。
// systemPrompt 为空（或占位符），sendCountdown=0（直接获得回复）。
// ============================================================

import type { ToolAccess } from '../tools'
import type { AgentClass } from './types'
import { makeAgentClassID } from './types'

/** user 类 id（内置根模板；user0 采用此类实例化）。 */
export const USER_CLASS_ID = makeAgentClassID('user')

/** 构造内置 user 类：tools = 系统工具权限配置（config.permission）。 */
export function createUserClass(tools?: Readonly<Record<string, ToolAccess>>): AgentClass {
  return {
    name: USER_CLASS_ID,
    description: 'user 类：系统根 agent（元 agent），由人类经 pilot 扮演；tools = 系统工具权限设置（config.permission）。',
    systemPrompt: '',
    tools: tools ?? {},
    sendCountdown: 0,
  }
}