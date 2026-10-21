# 鬼邮局 (GuiJi)

一个用 AI 帮你「读内容、理事情」的工具：把文件、图片、视频、链接、一段文字丢给它，
它会总结分析并自动把要做的事、到期日抽出来，落到一条时间轴上，到点提醒你。

线上地址：https://ghost-post.app.workbuddy.host/?sharecode=GT7GTQCHUK

## 功能

- **AI 分析**：Word / Excel / PPT / PDF / 图片 / 视频 / 链接 / 纯文本，生成摘要、关键数字、风险与待办
- **待办时间表**：按截止日分组（已逾期 / 今天 / 明天 / 三天内 / 本周 / 更晚）
  - 行内左滑：完成 / 标为重要 / 删除（5 秒内可撤销）
  - 长按多选，批量处理
  - 手工新建待办，支持每天 / 每周 / 每月 / 工作日重复，完成自动生成下一条
  - 标为重要的任务，到期当天 09:30 直接弹系统闹钟
  - 一键写进手机系统日历（APP 内直写 CalendarContract，网页版导出 .ics）
- **早报**：每天早上汇总今天要处理什么，重要的事单独拎出来
- **闹钟**：固定时间点提醒，开机自动恢复，可选短信兜底
- **APP**：安卓安装包（应用内自动更新），PWA 可加到桌面
- **手势**：子页任何位置右滑返回上一级，主板块左右滑动切换

## 运行

```bash
npm start        # 等价于 node server.js
# 环境变量 PORT 指定端口，默认 3000
```

零依赖，Node 18+ 即可。AI 能力由 WorkBuddy 云服务提供（前端直连，无需在服务器上放密钥）。

## 目录

```
web/
├── index.html          单页应用入口
├── server.js           零依赖 Node 服务：静态托管 / 版本检查 / 链接抓取 / 访问码
├── sw.js               Service Worker（通知 + 缓存）
├── manifest.json       PWA 清单
├── assets/
│   ├── app.js          全部前端逻辑（无框架，原生 JS）
│   ├── style.css
│   ├── pdf.min.js / pdf.worker.min.js   本地化的 pdf.js（legacy build）
│   └── ...
└── download/
    └── guiji-1.6.apk   安卓安装包（versionCode 7）
```

## 安卓 APP

`download/guiji-1.6.apk` 是 WebView 壳，原生能力通过 `window.GuijiApp` 桥接：

- 系统通知 + AlarmManager 闹钟（重启自动恢复）
- 短信兜底提醒
- 直写系统日历（CalendarContract）
- 剪贴板读取、应用内更新

壳工程不在本仓库内。

## 说明

- 数据存在用户手机本地（localStorage），服务器不落用户内容
- `sharecode` 是部署网关的访问码，与代码一起公开
