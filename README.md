# 城市公共树木养护协作系统

用于维护城市公共树木档案、巡检任务和居民异常反馈的基础协作系统。

## 技术栈

- 前端：Vite + React + TypeScript
- 后端：Node.js + TypeScript，内置 HTTP 服务
- 数据：当前使用内存数据，方便后续替换为 Repository、SQLite 或 PostgreSQL

## 基础流程

建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核

## 已实现

- 业务模块切换与基础列表展示
- 新增记录
- 基于状态的流程推进
- 异常反馈、巡检记录附件：上传（进度展示、失败重试）、列表（名称/大小/上传时间）、下载与删除
- `/api/health` 健康检查
- Vite 开发代理和前后端分离结构

## 附件接口

附件文件存储在 `uploads/` 目录（已 gitignore），元数据与业务数据一样保存在内存中，二进制不进入 JSON 字段。

- `POST /api/:resource/:id/attachments?filename=原始文件名`：请求体为文件二进制，`Content-Type` 为文件 MIME。仅 `reports`、`inspections` 支持；限图片（jpg/png/webp/gif）、视频（mp4/mov）、文档（pdf/txt/md/doc/docx/xls/xlsx），单文件 ≤ 10MB，单条记录 ≤ 9 个
- `GET /api/:resource/:id/attachments`：附件元数据列表
- `GET /api/:resource/:id/attachments/:attachmentId/download`：下载附件
- `DELETE /api/:resource/:id/attachments/:attachmentId`：删除附件

上传先写入临时文件，完成后再改名入库；上传中断或服务重启时临时文件会被清理。记录删除时其附件文件一并删除。

## 启动

```bash
npm install
npm run dev
```

前端：`http://localhost:5174`；后端：`http://localhost:4001`。

## 扩展点

当前版本只实现基础功能和主流程，数据使用内存存储。后续可增加用户认证、角色权限、分页检索、附件上传、通知、审计日志、数据库 Repository、领域事件和更细粒度的状态校验。
