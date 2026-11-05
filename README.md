# dotOJ for VS Code

在 VS Code 里浏览 [dotOJ](http://njuoj.skylare.me:9036) 的竞赛和题目，并把当前打开的 C 文件直接提交评测、等待结果。

## 功能

- **侧边栏题目树**：左侧活动栏出现 dotOJ 图标，按竞赛列出所有题目，已通过的题目显示对勾。
- **题目预览**：点开题目在右侧的「题目」面板里显示（辅助侧边栏，类似聊天窗口），不占用编辑器；代码文件始终在左侧打开，切换题目复用同一面板：正文交给 VS Code 内置 Markdown 渲染器（`markdown.api.render`），LaTeX 公式用内置 `markdown-math` 的 KaTeX 渲染，图片链接自动补全；顶部按钮可直接提交当前文件。
- **一键提交**：打开 `.c` 文件，点状态栏或按命令提交，自动按扩展名选择 C 语言。
- **实时评测**：提交后自动轮询，进度显示在通知里，结束弹出 AC / WA / TLE / CE 等结果与分数、耗时、内存。
- **编译信息**：CE / RE 时把编译器或运行器输出（去掉 ANSI 颜色）写进 `dotOJ` 输出面板。
- **文件 ↔ 题目绑定**：同一个文件下次提交会自动记住上一次选的题目。
- **下载题面**：一键把题面存成 Markdown，默认落在当前文件同级目录，文件名用题目的英文名（如 `gcd.md`）；题目预览页顶部也有一键下载按钮。

## 安装

```powershell
code --install-extension dotoj-vscode-0.1.0.vsix
```

装好后 **重载窗口**（`Ctrl+Shift+P` → `Developer: Reload Window`），左侧活动栏会出现 dotOJ 图标。

## 使用

1. 点侧边栏 dotOJ 图标 → 「登录 dotOJ…」，输入学号和密码（密码只存在 VS Code 的 SecretStorage 里）。
   也可以用 `dotOJ: 使用 Token 登录` 粘贴浏览器里 `localStorage` 的 `dotoj-auth` token。
2. 展开竞赛 → 点击题目，题面出现在右侧「题目」面板（会同时把它设为「当前题目」，状态栏显示题目名）。左侧编辑器不受影响。
3. 打开你的 `xxx.c`，按 `Ctrl+Alt+J`（或点状态栏「$(cloud-upload) 题目名」）提交。
   如果还没选题目，会弹出题目选择框。
4. 通知里显示评测进度，结束后弹出结果；详细编译信息在「输出 → dotOJ」里。
5. 想把题面存下来：在编辑器里 `Ctrl+Shift+P` → `dotOJ: 下载题面`，或在题目树上右键「下载题面」。

## 命令

| 命令 | 说明 |
| --- | --- |
| `dotOJ: 登录` | 学号 + 密码登录 |
| `dotOJ: 使用 Token 登录` | 粘贴 token（免密码） |
| `dotOJ: 退出登录` | 清除本地保存的 token |
| `dotOJ: 刷新` | 重新拉取竞赛和题目 |
| `dotOJ: 打开题目` | 选择题目并打开预览 |
| `dotOJ: 提交当前文件` | 提交当前编辑器内容 |
| `dotOJ: 下载题面` | 把当前题面保存为 Markdown |
| `dotOJ: 设为当前题目` | 从列表里选一个「当前题目」 |
| `dotOJ: 在浏览器中打开` | 用浏览器打开题目页 |
| `dotOJ: 显示评测输出` | 打开输出面板 |

树里的题目右键还有「提交当前文件到此题」「设为当前题目」「在浏览器中打开」。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dotoj.baseUrl` | `http://njuoj.skylare.me:9036` | OJ 地址 |
| `dotoj.pollIntervalMs` | `800` | 评测结果轮询间隔 |
| `dotoj.requestTimeoutMs` | `20000` | 单次请求超时 |
| `dotoj.downloadDirectory` | 空 | 题面保存目录；留空 = 当前文件所在目录，没有打开文件时用工作区根目录 |
| `dotoj.downloadFileNameTemplate` | `{stem}` | 文件名模板，可用 `{stem}`（英文名）、`{id}`、`{title}` |

## 实现说明

插件直接调用 dotOJ 的 HTTP API，不依赖浏览器：

| 用途 | 请求 |
| --- | --- |
| 登录 | `POST /api/v2/auth/login` `{username, password}` → `token` |
| 竞赛列表 | `GET /api/v2/contest?pageIndex=1&pageSize=100` |
| 竞赛详情（含题目） | `GET /api/v2/contest/{id}` |
| 题目 | `GET /api/v2/problem/{id}` |
| 语言 | `GET /api/v2/application/languages` |
| 提交 | `POST /api/v2/submission` `{problemId, program:{language, code:<base64>}}` |
| 轮询 | `GET /api/v2/submission/{id}`（`verdict` 0/1/2 表示未结束） |
| 编译信息 | `GET /api/v2/submission/{id}/detail`（`message` 为 base64 + ANSI） |

鉴权用 `Authorization: Bearer <token>`。

## 已知限制

- 计分作业需要在比赛开放时间、且已报名，否则服务端会拒绝提交（插件会把服务端返回的错误原样提示）。
- 只按扩展名自动匹配语言（`.c` → C）；其他语言会弹选择框。
- 题目预览是只读 Webview；顶部的「提交当前文件」按钮、状态栏、命令和树右键都能提交。

## 开发

源码结构与关键实现见 [SOURCE.md](SOURCE.md)。F5 可以直接启动扩展开发宿主（已带 `.vscode/launch.json`）。

```powershell
# 打包（无需 npm 依赖，脚本自己写 zip）
node scripts/pack-vsix.mjs

# 安装
code --install-extension .\dotoj-vscode-0.1.0.vsix --force
```
