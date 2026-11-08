# @silvermoon-work/task-engine-http

以可信 resolveCaller 和 EngineOptions.authorize 包装 TaskService，不从请求正文推断 Caller、scope 或能力。
提供 tasks、requests、Task messages 及十二项核心操作；没有 task-types：
提交/取消；Task/Run 各自的单体快照、历史、订阅、冻结目录和集合订阅。
单体观察路由为 `/tasks/:id`、`/tasks/:id/history`、`/tasks/:id/events` 及对应 `/runs/:id` 路由。
集合订阅为 `/tasks/events`、`/runs/events`；新订阅显式提供 `fromRevision` 或 Last-Event-ID 源 revision。
既有 event-history 与 events 别名保留，History 使用 taskId/runId/seriesId，但 Task 历史不再混入 Run progress。
`GET /runs` 使用独立 `list-runs` 权限，返回不含业务载荷的冻结 Run 摘要。
`GET /tasks?runId=…` 使用 Task `list` 权限查询已绑定关联需求；两种权限互不授予。
Run/Task/事件游标域独立，页面固定 revision、成员及观察时间，分页后从该 revision 补读。
一个源事件的全部集合变化在单个封装内原子交付；超限发送无 id 的 task.error，保留最后完整 revision。
安静流发送不含事件 id 的连接注释，确保 HTTP 连接可确认，但不产生领域事实。
旧 `/executions` 与 `executionId` 查询明确拒绝。
Request 使用 Idempotency-Key 和 Bundle 根 CID 字符串或 `{cid,hint}`，旧 If-Match 明确拒绝。
目录以 `bundleCid` 精确筛选，缓存接口按 CID 定位；hint 不参与内容匹配。
POST 返回 preparing（202）或 accepted/rejected（200），preparing 不是 Task。
GET `/requests/:id` 读取原始意图；GET `/requests/:id/status?waitMs=…`
独立读取/等待处理结果。long poll 到期不取消准备，断开只结束观察。
`TaskClient` 提供同协议的异步客户端，不在客户端将 preparing 伪造为 Task。

业务消息为 POST/GET `/tasks/:taskId/messages/:messageId`，POST 正文仅含 payload。
消息使用独立 message 服务授权、schema 校验和当前已绑定/已投递 Run 路由。
202/queued 不代表业务接纳；读取持久化 accepted/rejected/unknown，
重复同身份返回原状态，改变意图为冲突，Never 类型明确拒绝。
取消走 `/tasks/:taskId/cancel`，不受业务消息 schema 限制；断开 SSE 不取消 Task。

展示进度、结构化 checkpoint/Result 证据、deadline、共享与恢复边界见
[Task Engine](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-engine.md)。不支持旧 executionMatch 或旧结果形状 fallback。
`TaskClient.getRunLogs(id, {afterSequence, limit}, {signal})` reads retained
diagnostics. `subscribeRunLogs` is an abortable async-generator SSE client with
bounded frames and explicit gaps/status pages. See
[Run Logs](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-run-logs.md); these APIs are separate from Run events.
