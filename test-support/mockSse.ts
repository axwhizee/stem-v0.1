// ============================================================
// test-support/mockSse.ts —— 兼容再导出（正身已迁 shell/cli/mockSse.ts）
//
// S5.2 后 Docker 实跑暴露的错位：无 key mock 网关是**发布形态的产品能力**
// （Dockerfile 只 COPY src/shell/extension/templates），故文件本体归 shell
// （node:http 属宿主层，core 零平台依赖不破）。本 shim 保留既有测试引用面
// （src/core/gateway/opencodeLlm.test.ts 等直引 test-support 路径不动）。
// ============================================================

export * from '../shell/cli/mockSse'
