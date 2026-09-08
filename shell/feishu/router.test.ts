// ============================================================
// shell/feishu/router.test.ts —— 飞书 shell 纯逻辑层测试
// （身份闸门/命令路由/信箱分流/审批回调/渲染分箱——全决策面零 SDK）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRouterState,
  handleInbound,
  routeUserMail,
  parseAccessRequest,
  parseCardAction,
  applyWatchCommand,
  stripMentions,
  formatTree,
  splitForChat,
  resolveTarget,
  setSessionTarget,
  planReplay,
  type FetchedMsg,
  type InboundMsg,
} from './router'
import type { FeishuConfig } from './config'
import { FEISHU_CONFIG_DEFAULTS } from './config'

function cfg(patch: Partial<FeishuConfig> = {}): FeishuConfig {
  return { ...FEISHU_CONFIG_DEFAULTS, ownerOpenIds: ['ou_owner'], ...patch }
}

function state(patch: Partial<FeishuConfig> = {}): ReturnType<typeof createRouterState> {
  const s = createRouterState(cfg(patch))
  s.secretaryId = 'sec1'
  s.ownerChatId = 'oc_p2p'
  return s
}

function msg(patch: Partial<InboundMsg> = {}): InboundMsg {
  return { messageId: 'm1', chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_owner', text: '帮我查下天气', ...patch }
}

describe('身份闸门与基础路由', () => {
  test('owner 未配置 → 回认领指引（打印 open_id，人工回填）', () => {
    const s = createRouterState({ ...FEISHU_CONFIG_DEFAULTS, ownerOpenIds: [] })
    const acts = handleInbound(s, msg())
    assert.equal(acts.length, 1)
    assert.equal(acts[0]!.kind, 'reply')
    assert.match((acts[0] as { text: string }).text, /ou_owner/)
  })

  test('非 owner 消息零服务（无 reply 无 deliver）', () => {
    const s = state()
    assert.deepEqual(handleInbound(s, msg({ openId: 'ou_thief', messageId: 'm9' })), [])
  })

  test('owner 单聊普通消息 → deliver 接待员', () => {
    const s = state()
    const acts = handleInbound(s, msg())
    assert.deepEqual(acts, [{ kind: 'deliver', chatId: 'oc_p2p', to: 'sec1', text: '帮我查下天气' }])
  })

  test('message_id 去重（平台重试幂等）', () => {
    const s = state()
    assert.equal(handleInbound(s, msg()).length, 1)
    assert.equal(handleInbound(s, msg()).length, 0, '同一 messageId 二次投递被吞')
  })

  test('chatBindings 覆盖目标（群绑定 agent；未绑定群拒服）', () => {
    const s = state({ chatBindings: { 'oc_grp': 'tester42' } })
    assert.equal(resolveTarget(s, msg({ chatId: 'oc_grp', chatType: 'group', messageId: 'g1' })), 'tester42')
    assert.equal(resolveTarget(s, msg({ chatId: 'oc_other', chatType: 'group', messageId: 'g2' })), '', '未绑定群 = 空目标')
  })

  test('群聊 @ 占位剔除后投递', () => {
    const s = state({ chatBindings: { 'oc_grp': 'tester42' } })
    const acts = handleInbound(s, msg({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 跑一下测试', messageId: 'g3' }))
    assert.equal(stripMentions('@_user_1 跑一下测试'), '跑一下测试')
    assert.equal((acts[0] as { text: string }).text, '跑一下测试')
  })
})

describe('显式会话模型（CLI 式目标制）', () => {
  test('config.sessions 装载进内存镜像并抢占优先级（p2p 与群一视同仁）', () => {
    const s = createRouterState(cfg({ sessions: { oc_p2p: 'kid7', oc_grp: 'kid8' } }))
    s.secretaryId = 'sec1'
    assert.equal(resolveTarget(s, msg()), 'kid7', '显式会话 > 秘书')
    assert.equal(resolveTarget(s, msg({ chatId: 'oc_grp', chatType: 'group', messageId: 'g1' })), 'kid8', '群显式 > 绑定/拒服')
    assert.equal(resolveTarget(s, msg({ chatId: 'oc_g9', chatType: 'group', messageId: 'g2' })), '', '群未绑无目标 = 空')
  })

  test('/new /use /agents 派发为 command；/exit 本地解绑并触发回写钩子', () => {
    const events: Array<[string, string | null]> = []
    const s = createRouterState(cfg({ sessions: { oc_p2p: 'kid7' } }), { onSession: (c, t) => { events.push([c, t]) } })
    s.ownerChatId = 'oc_p2p'
    assert.deepEqual(handleInbound(s, msg({ text: '/new organizer 整理周报' })), [{ kind: 'command', chatId: 'oc_p2p', name: 'new', args: ['organizer', '整理周报'] }])
    assert.deepEqual(handleInbound(s, msg({ text: '/use kid#0-1', messageId: 'm2' })), [{ kind: 'command', chatId: 'oc_p2p', name: 'use', args: ['kid#0-1'] }])
    assert.deepEqual(handleInbound(s, msg({ text: '/agents', messageId: 'm3' })), [{ kind: 'command', chatId: 'oc_p2p', name: 'agents', args: [] }])
    const exits = handleInbound(s, msg({ text: '/exit', messageId: 'm4' }))
    assert.equal(exits[0]!.kind, 'reply')
    assert.deepEqual(events, [['oc_p2p', null]], 'exit 触发解绑回写')
    assert.equal(s.chatTargets.has('oc_p2p'), false)
  })

  test('秘书关闭（可选项退役）后未绑定单聊 = 指令指引，不再盲投', () => {
    const s = createRouterState({ ...cfg(), secretaryClass: '' })
    s.secretaryId = ''
    const acts = handleInbound(s, msg())
    assert.equal(acts[0]!.kind, 'reply')
    assert.match((acts[0] as { text: string }).text, /\/use/)
    assert.equal(resolveTarget(s, msg({ messageId: 'x', text: '/help' })), '', '无目标可解析')
  })

  test('setSessionTarget 双写（镜像 + 钩子）；ownerChat/seen 钩子随入站触发', () => {
    const seen: Array<[string, number]> = []
    let owner: string | undefined
    const s = createRouterState(cfg(), { onSession: (c, t) => { owner = `${c}=${t ?? '∅'}` }, onOwnerChat: (c) => { owner = undefined; void c }, onSeen: (c, at) => { seen.push([c, at]) } })
    setSessionTarget(s, 'oc_p2p', 'kid3')
    assert.equal(s.chatTargets.get('oc_p2p'), 'kid3')
    assert.equal(owner, 'oc_p2p=kid3')
    handleInbound(s, msg({ chatId: 'oc_q9', chatType: 'group', messageId: 'z1', text: '/agents' }))
    assert.equal(seen.length, 1)
    const g = createRouterState(cfg(), { onOwnerChat: (c) => { owner = c } })
    handleInbound(g, msg())
    assert.equal(owner, 'oc_p2p', 'p2p 首话记录主人会话')
  })
})

describe('断线补偿（planReplay）', () => {
  const f = (patch: Partial<FetchedMsg> = {}): FetchedMsg => ({
    messageId: 'fm1', chatId: 'oc_p2p', openId: 'ou_owner', senderType: 'person', text: '离线期间的话', createTimeMs: 100, ...patch,
  })

  test('过滤机器人/非主人/已见；乱序入参按时间升序重放', () => {
    const s = state()
    s.seen.add('fm2')
    const acts = planReplay(s, [
      f({ messageId: 'fm3', createTimeMs: 300 }),
      f({ messageId: 'fm2', createTimeMs: 200 }),
      f({ messageId: 'fm1', createTimeMs: 100 }),
      f({ messageId: 'fm4', senderType: 'app', createTimeMs: 400 }),
      f({ messageId: 'fm5', openId: 'ou_thief', createTimeMs: 500 }),
    ])
    assert.deepEqual(acts.map((a) => a.messageId), ['fm1', 'fm3'], '升序 + 已见/机器人/外人全滤')
    assert.equal(acts[0]!.chatType, 'p2p')
  })

  test('补偿重放走 handleInbound 全律（去重/闸门/会话目标）', () => {
    const s = state({ sessions: { oc_p2p: 'kid7' } })
    const replay = planReplay(s, [f()])
    assert.equal(replay.length, 1)
    const acts = handleInbound(s, replay[0]!)
    assert.deepEqual(acts, [{ kind: 'deliver', chatId: 'oc_p2p', to: 'kid7', text: '离线期间的话' }])
    const again = planReplay(s, [f()])
    assert.equal(again.length, 0, '已见消息不再进重放计划')
    assert.equal(handleInbound(s, { messageId: 'fm1', chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_owner', text: '离线期间的话' }).length, 0, '强行重放也被 LRU 吞')
  })
})

describe('命令面', () => {
  test('/tree 与未知指令', () => {
    const s = state()
    assert.deepEqual(handleInbound(s, msg({ text: '/tree' })), [{ kind: 'command', chatId: 'oc_p2p', name: 'tree', args: [] }])
    const bad = handleInbound(s, msg({ text: '/nope', messageId: 'm2' }))
    assert.equal(bad[0]!.kind, 'reply')
    assert.match((bad[0] as { text: string }).text, /未知指令/)
  })

  test('watch/unwatch 订阅集维护', () => {
    const s = state()
    applyWatchCommand(s, 'oc_p2p', 'watch', ['sec1'])
    applyWatchCommand(s, 'oc_p2p', 'watch', ['all'])
    assert.ok(s.watches.get('oc_p2p')!.has('*'))
    applyWatchCommand(s, 'oc_p2p', 'unwatch', ['all'])
    assert.ok(s.watches.get('oc_p2p')!.has('sec1'))
    applyWatchCommand(s, 'oc_p2p', 'unwatch', [])
    assert.equal(s.watches.get('oc_p2p')!.size, 0)
  })
})

describe('信箱分流（读 aloud / 审批）', () => {
  test('access_request XML 解析', () => {
    const req = parseAccessRequest(
      '<access_request id="r7" accessKey="edit" agent="tester#0-1"><EditFile path="a.py" ...>请用 access_reply 工具答复（requestId=r7）。</access_request>',
    )
    assert.deepEqual(
      { requestId: req?.requestId, accessKey: req?.accessKey, agentId: req?.agentId },
      { requestId: 'r7', accessKey: 'edit', agentId: 'tester#0-1' },
    )
    assert.equal(parseAccessRequest('普通信件'), undefined)
  })

  test('接待员回信 → 读 aloud 主人；旁支信使 → 审批卡（含附加群）', () => {
    const s = state({ approvalChatIds: ['oc_admin_grp'] })
    const acts = routeUserMail(s, [
      { from: 'sec1', content: '主人，天气晴。' },
      { from: 'tester#0-1', content: '<access_request id="r7" accessKey="edit" agent="tester#0-1">…</access_request>' },
      { from: '0', content: '（船长的话回声，不该读 aloud）' },
    ])
    assert.equal(acts[0]!.kind, 'reply')
    assert.equal((acts[0] as { text: string }).text, '主人，天气晴。')
    assert.equal(acts[1]!.kind, 'approvalCard')
    assert.deepEqual([...(acts[1] as { chatIds: readonly string[] }).chatIds], ['oc_p2p', 'oc_admin_grp'])
    assert.equal(acts.length, 2, '非接待员非审批信不读 aloud')
  })

  test('绑定 agent 的回信同样读 aloud', () => {
    const s = state({ chatBindings: { 'oc_grp': 'tester42' } })
    const acts = routeUserMail(s, [{ from: 'tester42', content: '测试全绿。' }])
    assert.equal((acts[0] as { kind: string }).kind, 'reply')
  })

  test('ownerChat 未知时零出口（还没人发过消息，无处可投）', () => {
    const s = state()
    s.ownerChatId = undefined
    assert.deepEqual(routeUserMail(s, [{ from: 'sec1', content: 'hi' }]), [])
  })
})

describe('审批卡回调与渲染', () => {
  test('按钮 value 判别（act/reply/requestId 齐才认）', () => {
    assert.deepEqual(parseCardAction({ act: 'access', reply: 'once', requestId: 'r7' }), { requestId: 'r7', reply: 'once' })
    assert.deepEqual(parseCardAction({ act: 'access', reply: 'reject', requestId: 'r7' }), { requestId: 'r7', reply: 'reject' })
    assert.equal(parseCardAction({ act: 'other', requestId: 'r7' }), undefined)
    assert.equal(parseCardAction({ act: 'access', reply: 'always', requestId: '' }), undefined)
    assert.equal(parseCardAction('nonsense'), undefined)
  })

  test('formatTree 缩进 + 徽标 + 空树兜底', () => {
    const tree = formatTree([
      { id: '0', name: 'user', classRef: 'user', parentId: '', status: 'idle', turnCount: 0 },
      { id: '0-1', name: 'sec1', classRef: 'assistant', parentId: '0', status: 'idle', turnCount: 3 },
      { id: '0-1-2', name: 'kid9', classRef: 'tester', parentId: '0-1', status: 'thinking', turnCount: 1 },
    ])
    assert.match(tree, /user#0 \(根\)/)
    assert.match(tree, /🟢 sec1#0-1 \(assistant, idle, 3轮\)/)
    assert.match(tree, /🔵 kid9#0-1-2/)
    assert.ok(tree.indexOf('kid9') > tree.indexOf('sec1'), '子在父后（缩进树序）')
    assert.match(formatTree([]), /旗下暂无实例/)
  })

  test('splitForChat 长文分箱不丢内容', () => {
    const long = Array.from({ length: 30 }, (_, i) => `第${i}行 ${'x'.repeat(60)}`).join('\n')
    const parts = splitForChat(long, 200)
    assert.ok(parts.length > 1)
    assert.equal(parts.join('\n'), long, '分箱重组无损')
    assert.ok(parts.every((p) => p.length <= 200))
    assert.deepEqual(splitForChat('  '), ['（空回复）'])
  })
})
