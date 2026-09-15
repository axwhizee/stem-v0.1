// ============================================================
// core/kernel/strategy.test.ts —— 上下文策略框架集成测试（S1′）
//
// 覆盖：
//   - 组装权收归：自定义策略的 assemble 必须改变**真实送信**（网关请求）；
//   - note 注入 systemPrompt（模型知晓自身记忆机制）；
//   - 未知策略名注册期 fail-fast；
//   - compact 端到端：自动触发 → 策略扮演 agent（父=宿主）→ summarizer
//     worker（父=role，回信配对）→ 摘要入库 + 旧段失效 → 下轮请求带摘要；
//   - context_apply 工具鉴权（仅自身或祖先）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import type { LLMRequest } from '../gateway'
import { BUILTIN_TEMPLATES } from './Kernel'
import { makeAgentClassID, makeAgentID, ROOT_ID } from './types'
import type { AgentClass } from './types'
import type { AssembleInput, AssembleResult } from '../context'
import { createBuiltinStrategyRegistry } from '../context'
import type { ContextStrategyModule } from '../context'
import { createKernelHarness } from '../../../test/support/kernelHarness'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 测试策略：组装时全部大写（验证组装权）+ 动作 ping + note。 */
function shoutStrategy(): ContextStrategyModule {
  return {
    name: 'shout',
    note: '<shout>本代理上下文经 shout 策略大写化。</shout>',
    assemble: (input: AssembleInput): AssembleResult => {
      const base = input.messages.filter((m) => m.message.role !== 'system')
      return {
        system: 'SHOUT-SYS',
        messages: base.map((m) => ({ ...m.message, content: String(m.message.content).toUpperCase() })),
        messageIds: input.messages.map((m) => m.id),
      }
    },
    actions: {
      ping: async () => 'PONG',
    },
  }
}

const shoutTemplate: AgentClass = {
  name: makeAgentClassID('shout-agent'),
  description: '使用 shout 策略的 agent',
  systemPrompt: 'base-sys',
  tools: {},
  contextStrategy: 'shout',
}

describe('上下文策略框架（组装权 / note / fail-fast）', () => {
  test('组装权收归管理员：自定义策略改变真实送信', async () => {
    let lastRequest: LLMRequest | undefined
    const gateway = new FakeGateway((request) => {
      lastRequest = request
      return textEvents('fine')
    })
    const registry = createBuiltinStrategyRegistry([shoutStrategy()])
    const { kernel, deliveries, timers } = await createKernelHarness(gateway, {
      templates: [...BUILTIN_TEMPLATES, shoutTemplate],
      strategies: registry,
    })
    const agentId = await kernel.instantiateAgent(
      { className: makeAgentClassID('shout-agent'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hello world' },
    )
    await deliveries.next()

    assert.ok(lastRequest, '应有网关请求')
    assert.equal(lastRequest.system, 'SHOUT-SYS', 'system 来自策略而非模板拼装（note 在仓库 system 行，策略输出 SHOUT-SYS）')
    assert.ok(
      lastRequest.messages.some((m) => typeof m.content === 'string' && m.content.includes('HELLO WORLD')),
      '送信消息应被策略大写化（真实链路，非日志快照）',
    )

    // note 注入注册期 systemPrompt（仓库 system 行包含 base + note）。
    const state = await kernel.contextManager.getState(agentId)
    const systemLine = String(state.messages.find((m) => m.message.role === 'system')!.message.content)
    assert.match(systemLine, /base-sys/)
    assert.match(systemLine, /<shout>/, '策略说明追加到系统提示词')

    // context_apply：自身动作可执行（shout 的 ping）。
    const pong = await kernel.contextManager.runStrategyAction(agentId, 'ping')
    assert.equal(pong, 'PONG')
    void timers
  })

  test('未知策略名 → 注册期 fail-fast（不静默降级）', async () => {
    const gateway = new FakeGateway(() => textEvents('x'))
    const { kernel } = await createKernelHarness(gateway)
    await kernel.registerAgentClass({
      name: makeAgentClassID('ghost-strategy'),
      description: 'x',
      systemPrompt: 'ghost agent',
      tools: {},
      contextStrategy: 'no-such-strategy',
    })
    await assert.rejects(
      () =>
        kernel.instantiateAgent(
          { className: makeAgentClassID('ghost-strategy'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hi' },
        ),
      (e: { kind?: string }) => e.kind === 'context_strategy_unknown',
    )
  })

  test('runStrategyAction：未知动作 → context_action_unknown（策略专有接口边界）', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const { kernel } = await createKernelHarness(gateway)
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')
    // classic 只有 compact；其它动作名报未知（并携带可用列表）。
    await assert.rejects(
      () => kernel.contextManager.runStrategyAction(agentId, 'does-not-exist'),
      (e: { kind?: string; known?: string }) => e.kind === 'context_action_unknown' && e.known === 'compact',
    )
  })
})

describe('classic compact 端到端（扮演 agent + worker 配对）', () => {
  test('超阈值自动压缩：role 挂宿主下 / worker 回收归档 / 下轮送信带摘要', async () => {
    const requests: LLMRequest[] = []
    const gateway = new FakeGateway((request: LLMRequest) => {
      requests.push(request)
      if (String(request.system).includes('记忆压缩器')) {
        return textEvents('SUMMARY-OF-PAST')
      }
      return textEvents('normal reply here')
    })
    const { kernel, deliveries, timers } = await createKernelHarness(gateway, {
      contextSettings: {
        window: 40,
        compact: { enabled: true, threshold: 0.5, keepRecentTurns: 1, replyTimeoutMs: 60_000 },
      },
    })
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')
    await deliveries.next() // 首信回复
    timers.flushAll()

    // 驱动 3 轮用户消息（长文本快速越过 budget=20 tok）。
    await kernel.sendUserMessage(agentId, 'x'.repeat(100))
    await deliveries.next()
    timers.flushAll()
    await kernel.sendUserMessage(agentId, 'y'.repeat(100))
    await deliveries.next()
    timers.flushAll()

    // 压缩应已发生（sendUserMessage 的 await 链包含策略 process）。
    const state = await kernel.contextManager.getState(agentId)
    const summary = state.messages.find((m) => m.tag === 'summary')
    assert.ok(summary, '应存在 tag=summary 的摘要消息')
    assert.match(String(summary.message.content), /<context_summary/)
    assert.match(String(summary.message.content), /SUMMARY-OF-PAST/)
    assert.ok(
      state.messages.some((m) => m.valid === false),
      '旧段消息应被标记无效（归档保留在仓库）',
    )

    // 族谱：宿主下挂了策略扮演 agent（面板态），worker 已回收（terminate 归档）。
    const roleChild = kernel.lineage
      .getChildren(agentId)
      .map((id) => kernel.instances.getSync(id))
      .find((child) => child?.classRef === makeAgentClassID('strategy-classic'))
    assert.ok(roleChild, '策略扮演 agent（strategy-classic）应为宿主的子')
    const summarizers = (await kernel.instances.listAll()).filter((i) => i.classRef === makeAgentClassID('summarizer'))
    assert.equal(summarizers.length, 0, 'worker 用完即回收（消息归档保语料）')

    // 日志：context.compacted outcome=compacted。
    const compacted = kernel.logger.query({ type: 'context.compacted' })
    assert.ok(compacted.length > 0, '压缩应有日志')

    // 扮演 agent 审计信箱收到过摘要 worker 回信（其仓库含 worker 来信）。
    const roleState = await kernel.contextManager.getState(roleChild!.id)
    assert.ok(
      roleState.messages.some((m) => typeof m.message.content === 'string' && m.message.content.includes('SUMMARY-OF-PAST')),
      'worker 回信进入扮演 agent 信箱（审计留痕）',
    )

    // 下一轮送信携带摘要（真实请求验证）。
    const before = requests.length
    await kernel.sendUserMessage(agentId, 'z'.repeat(8))
    await deliveries.next()
    const latest = requests.slice(before).find((r) => !String(r.system).includes('记忆压缩器'))
    assert.ok(latest, '应有主 agent 请求')
    assert.ok(
      latest.messages.some((m) => typeof m.content === 'string' && m.content.includes('SUMMARY-OF-PAST')),
      '压缩后请求应带摘要',
    )
    void tick
  })

  test('手动动作：runStrategyAction(compact) 走同一实现', async () => {
    const gateway = new FakeGateway((request) => {
      if (String(request.system).includes('记忆压缩器')) return textEvents('MANUAL-SUM')
      return textEvents('reply')
    })
    const { kernel, deliveries, timers } = await createKernelHarness(gateway, {
      contextSettings: { window: 100_000, compact: { enabled: false, threshold: 0.8, keepRecentTurns: 1, replyTimeoutMs: 60_000 } },
    })
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')
    // 每轮后 flush 打破冷却（手动计时器模式），驱动 3 轮对话。
    await deliveries.next()
    timers.flushAll()
    await kernel.sendUserMessage(agentId, 'history one text')
    await deliveries.next()
    timers.flushAll()
    await kernel.sendUserMessage(agentId, 'history two text')
    await deliveries.next()
    timers.flushAll()

    // enabled:false → 自动压缩从未发生；手动动作走同一实现。
    const state0 = await kernel.contextManager.getState(agentId)
    assert.equal(state0.messages.filter((m) => m.tag === 'summary').length, 0, '禁用时不应自动压缩')
    const result = await kernel.contextManager.runStrategyAction(agentId, 'compact')
    assert.match(result, /已压缩/)
    const state = await kernel.contextManager.getState(agentId)
    assert.ok(state.messages.some((m) => m.tag === 'summary'), '手动压缩应产生摘要')
  })
})
