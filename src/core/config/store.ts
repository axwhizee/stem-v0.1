// ============================================================
// core/config/store.ts —— 配置存储接口（纯 TS，fs 由宿主注入）
//
// core 零平台依赖：文件读取/写入经 `ConfigStore` 接口注入，
// 宿主（shell/node、VSCode）各自实现。
// ============================================================

import type { ConfigLoadResult, StemConfig } from './types'

/** 配置存储（读 + 写，保持 core 无 fs 依赖）。 */
export interface ConfigStore {
  /** 加载配置（文件不存在时返回 exists=false 与默认配置）。 */
  readonly load: () => Promise<ConfigLoadResult>
  /** 保存配置（写入原始文本；宿主负责 JSONC 序列化/目录创建）。 */
  readonly save: (text: string) => Promise<void>
  /** 配置文件绝对路径（供展示/日志）。 */
  readonly file: string
}

/** 配置目录解析（`.stem/` 的固定子目录结构）。 */
export interface ConfigPaths {
  /** 项目空间根目录。 */
  readonly projectRoot: string
  /** 配置目录（`<projectRoot>/.stem/`）。 */
  readonly configDir: string
  /** 配置文件路径（`stem.jsonc` 或 `stem.json`）。 */
  readonly configFile: string
  /** 用户工具目录（`<projectRoot>/.stem/tool/`）。 */
  readonly toolDir: string
  /** 用户 agent 目录（`<projectRoot>/.stem/agent/`）。 */
  readonly agentDir: string
}
