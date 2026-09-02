import { tool } from "@opencode-ai/plugin";
import { zhihuGet } from "./_zhihu";

// ═══ 阿里云 (Dashscope) WebSearch MCP ═════════════════════════════════

const MCP_URL = "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp";
const API_KEY = "sk-fc9ca3c141f744868237c85ecc679c3e";

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface ContentBlock {
  type: string;
  text: string;
}

interface CallResult {
  content: ContentBlock[];
  isError?: boolean;
}

interface AliyunPage {
  title?: string;
  url?: string;
  snippet?: string;
  hostname?: string;
}

let _initialized = false;

async function mcpCall<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body: JsonRpcResponse<T> = await res.json();
  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return body.result!;
}

async function ensureInitialized(): Promise<void> {
  if (_initialized) return;
  await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "opencode", version: "1.0" },
  });
  _initialized = true;
}

// ═══ 知乎结果类型 ═════════════════════════════════════════════════════

interface ZhihuItem {
  Title?: string;
  Url?: string;
  ContentType?: string;
  ContentText?: string;
  AuthorName?: string;
  VoteUpCount?: number;
  CommentCount?: number;
  RankingScore?: number;
}

// ═══ 格式化 ══════════════════════════════════════════════════════════

function clean(s: string | undefined, max = 500): string {
  if (!s) return "";
  const t = s.replace(/[\n\r]+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "..." : t;
}

function formatAliyun(text: string): string {
  let data: { pages?: AliyunPage[] };
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  const pages = data.pages;
  if (!pages || pages.length === 0) return "未找到相关结果。";
  return pages
    .map((p, i) => {
      const parts = [`${i + 1}. **${p.title ?? "(无标题)"}**`, `   URL: ${p.url ?? ""}`];
      if (p.hostname) parts.push(`   来源: ${p.hostname}`);
      const snippet = clean(p.snippet);
      if (snippet) parts.push(`   ${snippet}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function formatZhihu(items: ZhihuItem[], source: string): string {
  if (!items.length) return "未找到相关结果。";
  const head =
    source === "zhihu_search"
      ? `（来源：知乎站内搜索）`
      : `（来源：知乎全网搜索）`;
  return (
    head +
    "\n\n" +
    items
      .map((it, i) => {
        const parts = [`${i + 1}. **${it.Title ?? "(无标题)"}**`];
        if (it.ContentType) parts.push(`   类型: ${it.ContentType}`);
        if (it.AuthorName) parts.push(`   作者: ${it.AuthorName}`);
        const snip = clean(it.ContentText);
        if (snip) parts.push(`   ${snip}`);
        parts.push(`   URL: ${it.Url ?? ""}`);
        const meta: string[] = [];
        if (typeof it.VoteUpCount === "number") meta.push(`赞 ${it.VoteUpCount}`);
        if (typeof it.CommentCount === "number") meta.push(`评论 ${it.CommentCount}`);
        if (typeof it.RankingScore === "number") meta.push(`分 ${it.RankingScore.toFixed(2)}`);
        if (meta.length) parts.push(`   统计: ${meta.join(" / ")}`);
        return parts.join("\n");
      })
      .join("\n\n")
  );
}

// ═══ 工具定义 ════════════════════════════════════════════════════════

export default tool({
  description:
    "统一网页搜索工具，支持三种数据源并可用 source 参数切换：auto(默认，知乎全网优先、阿里兜底) | aliyun(阿里云，百科/新闻/天气等开放域) | global(知乎全网搜索，可限定站点 host 与发布时间) | zhihu(知乎站内搜索，社区观点/真实经验)。适合实时或开放域查询，中英文皆可。比较不同来源的效果时用显式 source 调用。",

  args: {
    query: tool.schema.string().describe("搜索关键词"),
    count: tool.schema
      .number()
      .default(5)
      .describe("结果数，默认 5，最大 20"),
    source: tool.schema
      .string()
      .default("auto")
      .describe("auto | aliyun | global | zhihu"),
    filter: tool.schema
      .string()
      .optional()
      .describe('global 源高级筛选，如 host=="example.com" AND publish_time>=1778494631，AND/OR 必须大写'),
    searchDb: tool.schema
      .string()
      .default("all")
      .describe("global 源索引库：all | realtime | static"),
  },

  async execute(args) {
    const source = args.source ?? "auto";
    const count = Math.min(args.count ?? 5, 20);

    async function callAliyun(): Promise<string> {
      await ensureInitialized();
      const result = await mcpCall<CallResult>("tools/call", {
        name: "bailian_web_search",
        arguments: { query: args.query, count },
      });
      for (const block of result.content ?? []) {
        if (block.type === "text" && block.text) return formatAliyun(block.text);
      }
      return JSON.stringify(result);
    }

    // 知乎站内
    if (source === "zhihu") {
      const data = await zhihuGet<{ Items: ZhihuItem[] }>("zhihu_search", {
        Query: args.query,
        Count: Math.min(count, 10),
      });
      return formatZhihu(data.Items ?? [], "zhihu_search");
    }

    // 知乎全网
    if (source === "global") {
      const data = await zhihuGet<{ HasMore: boolean; Items: ZhihuItem[] }>(
        "global_search",
        { Query: args.query, Count: count, Filter: args.filter, SearchDB: args.searchDb },
      );
      return formatZhihu(data.Items ?? [], "global_search");
    }

    // 阿里
    if (source === "aliyun") {
      return callAliyun();
    }

    // auto: 知乎全网优先，失败/空则阿里兜底
    try {
      const data = await zhihuGet<{ Items: ZhihuItem[] }>("global_search", {
        Query: args.query,
        Count: count,
        Filter: args.filter,
        SearchDB: args.searchDb,
      });
      if (data.Items?.length) return formatZhihu(data.Items, "global_search");
    } catch {
      // 知乎不可用（未配置密钥等），继续阿里兜底
    }
    return callAliyun();
  },
});
