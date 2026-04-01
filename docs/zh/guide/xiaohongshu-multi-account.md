# 小红书多账号管理指南

## 添加账号

### 1. 注册账号配置

```bash
opencli xiaohongshu accounts add --name <账号名> 
```

示例：

```bash
opencli xiaohongshu accounts add --name 2mg 
opencli xiaohongshu accounts add --name xhs22
```

### 2. 启动独立 Chrome Profile（需要加载一下浏览器扩展opencli）



```powershell
cd "C:\Program Files\Google\Chrome\Application" （Chrome安装位置）
chrome --user-data-dir="D:\Users\zhenjie.liu\.opencli\profiles\xhs-<账号名>"
```

示例：

```powershell
cd "C:\Program Files\Google\Chrome\Application" 
chrome --user-data-dir="D:\Users\zhenjie.liu\.opencli\profiles\xhs-2mg"
```

这会打开一个全新的 Chrome 窗口。

### 3. 登录小红书创作者中心

在新窗口中访问 `https://creator.xiaohongshu.com` 并登录。

### 4. 查看已添加的账号

```bash
opencli xiaohongshu accounts list
```

---

## 使用账号发布内容

### 切换账号

关闭当前 Chrome，用目标账号的 Profile 启动：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="D:\Users\zhenjie.liu\.opencli\profiles\xhs-2mg"
```

### 发布笔记

确认 Chrome 已登录后，直接执行：

```bash
opencli xiaohongshu publish --title "标题" "正文内容..." --images "图片路径.jpg"
```

示例：

```bash
opencli xiaohongshu publish --title "AI工具推荐" "今天分享几个好用的AI工具..." --images "D:\images\cover.jpg"
```

### 常用命令

```bash
# 查看账号信息
opencli xiaohongshu creator-profile

# 查看笔记列表
opencli xiaohongshu creator-notes --limit 10

# 查看数据总览
opencli xiaohongshu creator-stats --period seven

# 查看单篇笔记详情
opencli xiaohongshu creator-note-detail <笔记ID>
```

### 注意事项

- **串行操作**：每次只能操作一个账号，切换账号需要关闭当前 Chrome 并用新 Profile 启动
- **Cookie 隔离**：不同 Profile 的登录态完全独立，互不影响
- **扩展状态**：确保 OpenCLI 扩展已加载并启用（`chrome://extensions/`）
- **Daemon 连接**：执行命令前可用 `opencli doctor` 检查连接状态
