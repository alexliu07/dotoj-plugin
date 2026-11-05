# 源码目录说明

这是 dotOJ VS Code 插件的完整独立源码，可直接用 VS Code 打开本文件夹。

## 目录结构

```
dotoj-plugin/
├─ package.json          扩展清单：贡献点（视图容器/命令/菜单/快捷键/配置）、版本、入口
├─ src/
│  ├─ extension.js       activate/deactivate：树视图、登录、提交轮询、题面视图、下载、状态栏
│  ├─ api.js             dotOJ HTTP 客户端（零依赖，node http/https）
│  ├─ markdown.js        题目 JSON → Markdown（样例 base64 解码、相对图片补全）
│  └─ verdicts.js        verdict 码 → AC/WA/TLE/CE… 及 pending/accepted 判定
├─ media/
│  ├─ icon.svg           活动栏 / 侧边栏图标
│  ├─ preview.css        题面 Webview 样式（跟随 VS Code 主题变量）
│  └─ katex/             KaTeX 样式与字体（复制自 VS Code 内置 markdown-math）
├─ scripts/pack-vsix.mjs 零依赖 VSIX 打包器（自己写 ZIP）
├─ .vscode/launch.json   F5 启动扩展开发宿主
├─ README.md             用户文档
├─ CHANGELOG.md          版本记录
└─ LICENSE               MIT
```

## 开发

```powershell
# 语法检查
node --check src/extension.js

# 打包（生成 dotoj-vscode-<version>.vsix）
node scripts/pack-vsix.mjs

# 安装
code --install-extension .\dotoj-vscode-0.3.2.vsix --force
```

调试：用 VS Code 打开本文件夹，按 `F5` 启动 Extension Development Host。

## 关键实现点

- 插件直接调 dotOJ 的 `api/v2`，登录拿到 JWT 后放 `SecretStorage`，请求带 `Authorization: Bearer`。
- 题面用 `markdown.api.render`（VS Code 内置渲染器）+ 内置 KaTeX 样式渲染，不依赖外网 CDN。
- 题面显示在 `secondarySidebar` 的 Webview View 中，不占用编辑器分组。
- 提交后轮询 `GET /api/v2/submission/{id}`，`verdict` 0/1/2 视为未结束。