# 参与贡献

欢迎提交问题反馈、翻译改进和 Pull Request。较大的功能改动请先开 Issue 讨论使用场景，避免重复工作。

## 本地开发

项目使用原生 JavaScript、HTML 和 CSS，没有运行时依赖。使用 Node.js 20+；持续集成使用 Node.js 24。运行测试前执行 `npm ci`，安装测试专用的 IndexedDB 模拟依赖。

1. Fork 仓库，从 `main` 新建分支。
2. 在 Chrome 扩展管理页开启开发者模式，加载仓库根目录。
3. 完成修改后集中运行 `npm run check`、`npm test` 和 `npm run build`。
4. 提交 PR，说明解决的问题、行为变化和实际验证结果。

主分支通过 PR 合并，合并前须通过 `validate` 检查并解决审查讨论。项目采用 squash 合并，请让每个 PR 聚焦一个问题。

核心测试使用本地模拟数据。不要在自动化测试中调用真实模型服务或修改真实账号的屏蔽关系。UI 修改可以附截图并说明手工验证步骤，不要求 UI 单元测试。

## 翻译

直接编辑 `_locales/<语言代码>/messages.json`，沿用 Chrome 原生格式。保持消息键和占位符一致，按当地习惯翻译。不要翻译用户的 Prompt、分类选项或推文内容。新增语言时同步更新 `scripts/extension-files.mjs`。

## 提交范围

不要提交 API Key、Cookie、个人导出记录、`.local/`、构建产物或调试日志。发布文件由 `scripts/extension-files.mjs` 明确列出，不能直接打包整个仓库。

提交的代码和文档沿用项目的 AGPL-3.0-only 许可证；引入第三方内容时请标明来源及许可证。

## Reporting issues in English

English issues and pull requests are welcome. Include the extension version, Chrome version, reproduction steps, and expected versus actual behavior. Remove credentials and private data from logs and screenshots. For security-sensitive reports, use the repository's private vulnerability reporting feature instead of posting exploit details in a public issue.
