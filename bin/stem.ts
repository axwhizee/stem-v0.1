/**
 * stem 单文件统一入口（部署试验）：stem <shell|web|dashboard|feishu|version>
 * 动态 import 各 shell 入口；打包后仍可从磁盘加载 `.stem/**` 用户资源（若运行时具备 TS 加载能力）。
 */
const cmd = process.argv[2] ?? 'shell'
const rest = process.argv.slice(3)

async function main(): Promise<void> {
  switch (cmd) {
    case 'shell':
    case 'cli':
      process.argv = [process.argv[0]!, 'stem', ...rest]
      await import('../shell/cli/main')
      break
    case 'web':
    case 'webui':
      process.argv = [process.argv[0]!, 'stem', ...rest]
      await import('../shell/webui/server')
      break
    case 'dashboard':
      process.argv = [process.argv[0]!, 'stem', ...rest]
      await import('../shell/dashboard/server')
      break
    case 'feishu':
      process.argv = [process.argv[0]!, 'stem', ...rest]
      await import('../shell/feishu/main')
      break
    case 'version':
    case '--version':
    case '-v':
      console.log('stem 0.1.0-exe')
      break
    case 'help':
    case '--help':
    case '-h':
      console.log('usage: stem <shell|web|dashboard|feishu|version> [args…]')
      break
    default:
      console.error(`未知子命令: ${cmd}`)
      console.error('usage: stem <shell|web|dashboard|feishu|version> [args…]')
      process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
