// ============================================================
// shell/cli/gateway.ts —— provider 网关装配 + 路由（S6/R1 宿主门面）
//
// 零兜底纪律（docs/s6-plan.md R1/R2/R13）：
//   - 端点/密钥/白名单全部来自 config.providers（宿主读 env 注入，core 零平台）；
//   - key_env 未命中 = **启动 warn 点名**（不印值）+ provider 不接通；
//   - 未接通/未注册的 provider 被**实际用到才硬错**（GatewayError，文案可行动）；
//   - 产品路径无 mock——离线冒烟把 mockSse 作为普通匿名 provider 写进测试 config。
// ============================================================

import { randomUUID } from 'node:crypto'
import { version as STEM_VERSION } from '../../package.json'
import {
  createOpenAiCompatibleGateway,
  GatewayError,
  type ModelGateway,
} from '../../src/core/gateway'
import type { StemConfig } from '../../src/core/config'

// ---------- 客户端身份（v1.0 用户裁决：opencode 运营要求全部关在本宿主文件，core 零感知） ----------
// 2026-09 邮件要求：opencode.ai 系请求须带 x-opencode-session（每会话稳定 id），
// 且点名裸 "Node fetch" UA 需整改。策略：
//   - User-Agent: stem/<version> —— 全体 provider 通用客户端礼仪（无害且自证身份）；
//   - x-opencode-session: 每 **stem 进程**一个随机 id —— 容器即会话（进程内稳定满足
//     "stable per conversation"，进程间随机、零持久化、不编码任何 agent/空间身份，
//     拒绝全局硬编码值：镜像分发下全用户共享一个 session 会被服务端限流连坐）。

const PROCESS_SESSION_ID = randomUUID()
const STEM_USER_AGENT = `stem/${STEM_VERSION}`

/** 包一层 fetch 注入请求头（openaiCompatible 的 config.fetch 端口，core 零改动）。 */
export function providerFetch(baseUrl: string): typeof fetch {
  let isOpencode = false
  try {
    isOpencode = /(^|\.)opencode\.ai$/i.test(new URL(baseUrl).hostname)
  } catch {
    // 非法 url：交给 core 装配期校验报错，这里只按非 opencode 处理。
  }
  return (input, init) => globalThis.fetch(input, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      'User-Agent': STEM_USER_AGENT,
      ...(isOpencode ? { 'x-opencode-session': PROCESS_SESSION_ID } : {}),
    },
  })
}

export interface BuiltGateway {
  readonly gateway: ModelGateway
  /** 接通概览（/source 与健康检查展示）。 */
  readonly source: string
  /** 启动告警（key_env 未命中等，宿主负责 console.warn）。 */
  readonly warnings: readonly string[]
  /** 实际接通的 provider 名（有序）。 */
  readonly wired: readonly string[]
}

/** 按 config.providers 逐条建网关，返回按 request.model.provider 路由的门面。 */
export function buildGateway(config: StemConfig, env: NodeJS.ProcessEnv): BuiltGateway {
  const warnings: string[] = []
  const routes = new Map<string, ModelGateway>()
  /** 未接通原因（provider → 可行动文案；用到才抛，R1 两段式第二段）。 */
  const unwired = new Map<string, string>()
  const wired: string[] = []

  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const apiKey = provider.key_env !== undefined ? env[provider.key_env] : undefined
    if (provider.key_env !== undefined && (apiKey === undefined || apiKey === '')) {
      const reason =
        `provider "${name}" 未接通：环境变量 $${provider.key_env} 未设置` +
        `（config providers.${name}.key_env 声明；修复：export ${provider.key_env}=<key> 或改配置）`
      warnings.push(reason)
      unwired.set(name, reason)
      continue
    }
    routes.set(
      name,
      createOpenAiCompatibleGateway({
        baseUrl: provider.base_url,
        ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
        ...(provider.models !== undefined ? { models: provider.models } : {}),
        fetch: providerFetch(provider.base_url),
      }),
    )
    wired.push(name)
  }

  const gateway: ModelGateway = {
    async * chat(request, options) {
      const target = routes.get(request.model.provider)
      if (target) {
        yield* target.chat(request, options)
        return
      }
      const reason =
        unwired.get(request.model.provider) ??
        `provider "${request.model.provider}" 未在 config providers 注册（已接通：${wired.length > 0 ? wired.join(', ') : '无'}）`
      throw new GatewayError({ kind: 'provider_unwired', message: reason })
    },
  }

  const source = wired.length > 0 ? `providers: ${wired.join(', ')}` : '（无已接通 provider——所有 LLM 调用将硬错）'
  return { gateway, source, warnings, wired }
}
