// ============================================================
// core/config/defaults.ts —— 首启自举模板（唯一"预设"的合法形态 = 数据）
//
// S6/R2：代码零端点常量——opencode zen 免费清单等一切"预设"只存在于
// 本模板文本；新空间首启落盘后即普通 config（用户可整体改写/删除）。
// 同时它也是**内存缺省配置**：config 文件不存在时的 in-memory 等效物
// （首启链路：load 不存在 → 本配置装配系统 → runInit 写出模板文件）。
// ============================================================

import { parseConfigText } from './parse'
import type { StemConfig } from './types'

/** 首启模板文本（必须保持 schema-clean：defaultStemConfig 全量校验通过）。 */
export const DEFAULT_CONFIG_TEXT = `{
  // stem 唯一配置文件（.stem = 世界：配置/类/工具/上下文策略/DB 皆在本目录）。
  // 用户工具/agent/策略**目录即真相**：放进 .stem/tools/、.stem/agent/、
  // .stem/context/ 即自动注册，无镜像字段。
  //
  // providers —— 模型提供商注册表（零兜底：端点全部 config 声明，代码无预设）。
  //   base_url：OpenAI 兼容端点（实际 POST {base_url}/chat/completions，请求发裸模型 id）
  //   key_env： 密钥所在**环境变量名**（配置文件永不承载明文密钥；缺省 = 匿名/本地端点）
  //   models：  启用白名单（空数组 = 全启用）
  // 下面唯一预设条目只是模板数据——复制本块即可接入任意兼容端点，例如：
  //   "alibaba": { "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  //                "key_env": "ALIBABA_API_KEY", "models": ["qwen3.8-flash", "qwen3.8-max"] }
  "providers": {
    "opencode-go": { "base_url": "https://opencode.ai/zen/go/v1", "key_env": "OPENCODE_API_KEY" }
  },
  // user0 内嵌 agent 类。model = **家学锚点**（必填）：全体 agent 的模型解析链
  //   显式（实例化/set_model）> 类基因 > 父继承 > 家学（本值）。
  "user": { "model": "opencode-go/deepseek-v4-flash" },
  "autoApprove": false,
  // 上下文策略（classic compact 参数面；summarizeModel 缺省 = 摘要 worker 继承宿主模型）。
  "context": { "window": 128000, "compact": { "enabled": true, "threshold": 0.8, "keepRecentTurns": 3 } },
  // bash 工具（缺省内置：120s 超时 / 50k 截断 / 项目根目录）。
  // "bash": { "defaultTimeoutMs": 120000, "maxOutputChars": 50000 },
  // 宿主 tool_set 包（["fs"] = read/write/edit/grep/glob；[] = 纯 bash 最小系统）。
  "extensions": ["fs"],
  "sendCountdown": 1000
}
`

/** 模板的解析产物（config 文件不存在时的内存缺省——首启链路与装配层共用）。 */
export function defaultStemConfig(): StemConfig {
  return parseConfigText(DEFAULT_CONFIG_TEXT, 'DEFAULT_CONFIG_TEXT')
}
