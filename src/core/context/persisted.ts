// ============================================================
// core/context/persisted.ts —— PersistedRepository（消息持久化装饰器）
//
// 内存为准 + write-through：读写全部委托包装的内层 Repository，
// 写操作（register/append/markInvalid/updateMessage/unregister）在
// 内存生效后同步落 MessageStore（单进程同步端口，崩溃窗口为零）。
// unregister = 归档（消息行保留，进化语料不丢；恢复时不加载）。
//
// 恢复路径（组合根启动时调用一次，非接口方法）：
//   restoreFromStore(): 读 store.loadBoxes() → inner.restore 逐箱重建，
//   再 inner.setCounterFloor(store.maxMessageSeq()) 防撞 id。
// ============================================================

import type { AppendInput, Repository } from './Repository'
import type { RepositoryState, StoredMessage } from './types'
import type { ChatMessage } from '../gateway'
import type { MessageStore } from './store'

/** Repository 装饰器：写穿 MessageStore（内存为准）。 */
export class PersistedRepository implements Repository {
  constructor(
    private readonly inner: Repository,
    private readonly store: MessageStore,
  ) {}

  /** 从 store 恢复内层内存态（启动装配调用；恢复期不反向写 store）。 */
  restoreFromStore(): void {
    for (const box of this.store.loadBoxes()) {
      this.inner.restore(box.agentId, box.messages)
    }
    this.inner.setCounterFloor(this.store.maxMessageSeq())
  }

  get onChange(): (agentId: string) => void {
    return this.inner.onChange
  }
  set onChange(fn: (agentId: string) => void) {
    this.inner.onChange = fn
  }

  async register(agentId: string, systemPrompt?: string): Promise<void> {
    await this.inner.register(agentId, systemPrompt)
    // register 可能生成首条 system 消息（id 由内层分配）→ 落现有行。
    for (const m of this.inner.getState(agentId).messages) this.store.upsert(m)
  }

  async append(agentId: string, input: AppendInput): Promise<StoredMessage> {
    const stored = await this.inner.append(agentId, input)
    this.store.upsert(stored)
    return stored
  }

  async unregister(agentId: string): Promise<void> {
    await this.inner.unregister(agentId)
    this.store.archiveAgent(agentId)
  }

  async markInvalid(agentId: string, ids: readonly string[]): Promise<void> {
    await this.inner.markInvalid(agentId, ids)
    this.repersist(agentId, ids)
  }

  async updateMessage(agentId: string, id: string, message: ChatMessage): Promise<void> {
    await this.inner.updateMessage(agentId, id, message)
    this.repersist(agentId, [id])
  }

  async setTokens(agentId: string, id: string, tokens: number): Promise<void> {
    await this.inner.setTokens(agentId, id, tokens)
    this.repersist(agentId, [id])
  }

  restore(agentId: string, messages: readonly StoredMessage[]): void {
    this.inner.restore(agentId, messages)
  }
  setCounterFloor(floor: number): void {
    this.inner.setCounterFloor(floor)
  }

  list(agentId: string): readonly StoredMessage[] {
    return this.inner.list(agentId)
  }
  listValid(agentId: string): readonly StoredMessage[] {
    return this.inner.listValid(agentId)
  }
  getState(agentId: string): RepositoryState {
    return this.inner.getState(agentId)
  }
  listRegistered(): readonly string[] {
    return this.inner.listRegistered()
  }
  has(agentId: string): boolean {
    return this.inner.has(agentId)
  }

  private repersist(agentId: string, ids: readonly string[]): void {
    const target = new Set(ids)
    for (const m of this.inner.getState(agentId).messages) {
      if (target.has(m.id)) this.store.upsert(m)
    }
  }
}
