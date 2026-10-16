# 粘贴打包 · dsh-paste-packer

给 DSH（DeepSeek Harness）Web GUI 用的粘贴打包插件，**网页版与桌面版通用**。

超过 **20 行**的粘贴文本不再直接灌进输入框，而是打包成一张卡片浮在输入框上方：

| 控件 | 行为 |
| --- | --- |
| 小眼睛 | 在卡片内就地预览原文（Markdown 渲染、等宽字体、自动折行、固定高度内滚动）；卡片宽度不变 |
| 展开 | 把全文解包插入输入框光标处，卡片消失 |
| 垃圾桶 | 丢弃这段粘贴内容，并移除输入框里的占位符 |

输入框正文里只留一个不可拆分的胶囊占位符 `[已粘贴文本 #1 · 23 行]`；**发送时由 DSH 自动把占位符还原成全文**，模型收到的是完整原文。

```
┌─────────────────────────────────────────────┐
│ 🗎 [已粘贴文本 #1 · 23 行]      👁  展开  🗑  │  ← conversation.input.dock
├─────────────────────────────────────────────┤
│ 也就是说，芯片完成了引导，正要开始运行……     │  ← 预览（点小眼睛后展开）
│ 需要注意的只有一点：日志在这里就截止了……     │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ → [已粘贴文本 #1 · 23 行]                ↑  │  ← 原本的 composer
└─────────────────────────────────────────────┘
```

## 为什么占位符是"胶囊"而不是纯文本

这不是设计偏好，而是 DSH 当前架构下的唯一可靠做法：

- 输入框是 shell 私有的 Lexical 编辑器，插件拿不到编辑器实例；
- DSH **没有**"提交前改写草稿"的钩子，`InputState.draft` 只是编辑器的纯文本投影；
- 因此纯文本占位符发出去就是占位符本身 —— 没有任何时机能把它换回全文；
- 官方唯一存在的展开点是触发源（trigger source）的 `codec.serialize(ref)`：提交路径按芯片 occurrence 逐段调用它，再拼接回草稿。

所以插件注册了一个内容永远为空的 `/` 触发源，它的 `codec` 才是这个插件的核心。

## 卡片为什么能和「任务」条对齐

`conversation.input.dock` 这一列比 composer 卡片**宽**，条目若用 `width: 100%` 就会向两侧溢出、盖住对话列。宿主自己的 dock 条目（任务/目标/队列条）靠一套 CSS 变量自我收窄，卡片照抄了同一份配方（对应宿主 `.aSus8q_root` 规则）：

```css
width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)
                 - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)
                 - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4);
margin: 0 auto;
border: 0;
border-radius: var(--dsw-radius-lg);
background: var(--dsw-specific-menu);
box-shadow: var(--dsw-elevation-panel);
backdrop-filter: var(--dsw-menu-backdrop-filter);
```

行内尺寸也照抄：`padding: 6px 12px` + `line-height: 24px` = **36px 一行**，标题 `13px/500`，图标与控件用 `--dsw-alias-label-tertiary`。预览区上限取宿主展开列表的 `max-height: 180px`。

**卡片折叠态与预览态共用一个宽度**（都取上面的公式，因此都近似等于 composer 卡片宽度）：点小眼睛只在卡片内就地展开预览，**宽度不动**。曾试过"预览时加宽到 140%"，两个问题让它被撤掉：一是会横向盖住对话列；二是 `margin-left/right: -20%` 配一个会生效的 `max-width` 时左侧外扩固定、右侧被截短，卡片会整体左偏。既然要的是"就地预览"，单一宽度最稳。

## 安装

推荐让 Agent 调用 `plugin_manager`：

```
action: install_bundle
target: <本目录绝对路径>
```

插件目录里的 `cordis.patch.yml` 会把 loader 行插进 profile，不需要手工改 profile 的 `package.json` / `cordis.patch.yml`。

`plugin_manager` 只作用于**当前** profile，所以要装进 web 与 desktop 两个 profile 时：

- 当前 profile 用 `plugin_manager` 的 `install_bundle`；
- 另一个 profile 用官方 CLI（它同样会同时写好 `dependencies` 与 `dsh.profile.bundles`）：

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

Windows 桌面版没有把 `dsh` 放进 PATH 时需要走安装包里的完整命令：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "D:\Users\shugang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals `
  "D:\Users\shugang\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile web add "link:<本目录绝对路径>"
```

用 `plugin_manager` 安装时按返回的 `application` 字段判断是否真的生效：`applied` 才是热生效，`restart-required` 需要重启 DSH。
用 CLI 装完可以用 `dsh --profile <name> --dump-config` 校验合成配置里出现了 `- id: dsh-paste-packer`（该命令会写 profile 的 `cordis.yml`，属常规产物）。

## 已知限制

- **原文只存在浏览器里**（内存 + `localStorage` 键 `dsh-paste-packer.v1`）。换浏览器、清站点数据、或超出存储上限后，旧卡片的原文会丢失；此时预览会提示"原文不可用"，发送会退化成发送占位符文字，而**不会**阻断发送。
- **卸载插件前请先清空输入框里残留的占位符胶囊。** 芯片的展开依赖本插件注册的 codec，插件不在时它无法被序列化。
- 垃圾桶/展开优先用"按 occurrence 区间做一次可撤销编辑"的方式；该路径失败时退化为整体重写草稿（`setDraft`），这会把草稿里**其他** `@文件` 引用芯片降级成纯文本。这是最后的兜底路径。
- 插件依赖三处非公开的宿主内部约定，均做了保护、失败时降级为原生粘贴：`[data-composer-input]`、`slash/input-insert-reference` 事件、`ctx.inputTriggers.registerSource`。DSH 升级后若其中一处改名，功能会静默失效（粘贴恢复原生行为），不会破坏输入框。

## 开发

```
package.json          bundle 清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml      loader 挂载声明
index.js              Host 半（故意为空）
client.js             浏览器半：全部逻辑与 UI（无 JSX、无构建、零依赖）
icon.svg              插件管理页图标
locale/{en,zh}.json   插件管理页展示文案
dev/                  仅开发用，不随 npm 包发布
  tools/extract-asar.mjs   从 app.asar 里按路径子串提取文件
  reference/               官方 cordis-plugin-development 技能与模板（本地参考）
  tests/logic-test.mjs     无浏览器环境下的逻辑自测
```

浏览器半按 DSH 的客户端模块协议加载：`window.__ModuleLoader__.load({ id, factory })`，React 从模块表里 `require('react')` 取得，因此**不需要**任何依赖、打包器或 React 副本。

## License

MIT
