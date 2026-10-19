# 界面排版与间距

适用于管理面板、提示词编辑器、模式说明及配置引导。保留原型结构，以紧凑桌面工具的阅读体验为目标。

## 基础尺寸

| 用途 | 字号 / 行高 | 字重 |
| --- | --- | --- |
| 正文、设置标签、输入控件 | 14 / 22 px | 400–500 |
| 时间、状态、辅助信息 | 12 / 18 px | 400–500 |
| 分组标题 | 16 / 24 px | 600 |
| 页面标题 | 20 / 28 px | 650 |
| 独立编辑器标题 | 24 / 32 px | 650 |
| 概览数字 | 28 / 36 px | 650 |

间距以 4 px 为步长：同组元素 8–12 px，列表行上下 16 px，页面内边距和分组留白 24 px。窄面板内边距 16 px。主操作高度 36–40 px，设置行至少 48 px。问号图标维持小尺寸，点击区域向外扩展 5 px。

使用本地系统字体，保留各语言字形回退；不额外下载网页字体。字号统一是统一同级信息，不是把标题、正文、说明全部压成同一大小。不用缩小字体解决窄屏挤压，优先换行或重新排列。

共享实现：`src/manager/ui-foundations.css`。加载在页面布局样式之后。设置页禁止重新引入 `#view-settings * { font-size: ... !important }` 一类无差别覆盖。

## 参考

- Carbon productive typography: https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets
- Atlassian typography: https://atlassian.design/foundations/typography/applying-typography
- Atlassian spacing: https://atlassian.design/foundations/spacing

以上规范用于建立层级和尺寸体系；这里的具体尺寸是为本项目作出的选择，不代表照搬某个组件库。

## 本轮验证

在本地模拟扩展消息的浏览器预览中检查仪表板、累计设置（600 px / 420 px）和提示词编辑器（1100 px）。这些检查中未出现横向溢出，设置标签和编辑器文本计算样式为 14 px / 22 px。语法、模块、资源及语言检查通过；构建包含 69 个文件。不涉及真实 Jev 或 X 操作。本轮未运行核心测试，未添加 UI 单元测试。
