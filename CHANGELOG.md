# Changelog

本文件记录每次发布的改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-16

首个版本。

### Added

- 粘贴超过 20 行时不再直接灌入输入框，而是插入一个引用芯片占位符 `[已粘贴文本 #N · M 行]`，
  并在 composer 上方（`conversation.input.dock`）渲染一张对应卡片；多段粘贴各自一张卡片，按编号纵向堆叠。
- 卡片小眼睛：在卡片内就地预览原文（Markdown 子集渲染、等宽字体、自动折行、180px 内滚动），
  展开与折叠两态宽度一致。
- 卡片「展开」：把全文解包插入输入框光标处，卡片消失（优先用按 occurrence 区间的一次可撤销编辑）。
- 卡片垃圾桶：丢弃该段粘贴内容并移除占位符。
- 发送时经 `ctx.inputTriggers` 的 `codec.serialize(ref)` 把占位符还原为完整原文，模型收到全文。
- 原文在浏览器侧留存（内存 + `localStorage` 键 `dsh-paste-packer.v1`），刷新页面后仍可还原。
- 卡片样式与「任务」条对齐：照抄宿主 dock 条目（`.aSus8q_root`）的宽度公式、
  menu 材质与 36px 行高。
- 中英文文案走 Client locale 服务；样式只使用 `--dsw-alias-*` / `--dsw-*` 主题 token。
- 无浏览器环境的逻辑自测 `dev/tests/logic-test.mjs`。

### Notes

- 依赖三处非公开的宿主内部约定（`[data-composer-input]`、`slash/input-insert-reference`
  事件、`ctx.inputTriggers.registerSource`），均已做保护并在失败时降级为原生粘贴。
  已测宿主版本：DSH `0.2.0-rc.2`。
- 卸载插件前请先清空输入框里残留的占位符芯片，否则该芯片无法被序列化。

[Unreleased]: https://example.com/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/tag/v0.1.0
