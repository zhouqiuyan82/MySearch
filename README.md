# Search API

基于 MongoDB 的 Node 搜索接口。服务启动后会先从 MongoDB 拉全量数据到内存，构建倒排索引，搜索请求直接查内存索引；MongoDB 作为唯一真实数据源。

## 运行前准备

先安装依赖：

```bash
cd /Users/tanshuo888/Code/work/search
npm install
```

设置环境变量：

```bash
export MONGODB_URI="mongodb://127.0.0.1:27017"
export MONGODB_DB="aichat"
export MONGODB_COLLECTION="characterlocalizations"
export REFRESH_INTERVAL_MS=3600000
```

也可以参考这个模板文件：

`/Users/tanshuo888/Code/work/search/.env.example`

如果后面老师提供了真实的 MongoDB 地址、库名、集合名，把对应值替换掉即可。

然后启动：

```bash
cd /Users/tanshuo888/Code/work/search
npm start
```

默认端口：`3000`

## 数据更新策略

- 启动时：从 MongoDB 全量拉取数据并重建索引。
- 运行中：按 `REFRESH_INTERVAL_MS` 定时重新拉取并重建索引。
- 手动刷新：调用 `POST /reload` 或 `GET /reload`。
- 刷新失败：保留上一版内存索引继续提供搜索，不会直接把服务打挂。

对于 1 万多条数据，这种“MongoDB 全量拉取 + 内存索引热更新”的方案是合适的，简单、稳定，而且搜索速度会明显比每次直接查库更快。

## 接口

- `GET /health`
- `GET /search?q=关键词&locale=可选语言&limit=可选数量`
- `POST /search`（JSON body：`{ "q": "...", "locale": "...", "limit": 10 }`）
- `POST /reload`（或 `GET /reload`）

## 示例

```bash
curl "http://127.0.0.1:3000/health"
curl "http://127.0.0.1:3000/search?q=mafia&limit=5"
curl "http://127.0.0.1:3000/search?q=moretti&locale=es&limit=3"

# 非英文推荐用 --data-urlencode，避免编码问题
curl --get "http://127.0.0.1:3000/search" --data-urlencode "q=マフィア"
curl --get "http://127.0.0.1:3000/search" --data-urlencode "q=Мафия"
curl --get "http://127.0.0.1:3000/search" --data-urlencode "q=माफिया"

# 或者直接用 POST JSON
curl -X POST "http://127.0.0.1:3000/search" \
  -H "Content-Type: application/json" \
  -d '{"q":"マフィア","limit":5}'

curl -X POST "http://127.0.0.1:3000/reload"
```

## 健康检查返回重点

- `size`：当前内存索引中的文档数
- `lastLoadedAt`：最近一次成功加载 MongoDB 的时间
- `lastRefreshError`：最近一次刷新失败原因
- `reloading`：当前是否正在后台刷新

## 优化点

- 启动时一次性构建内存倒排索引，避免每次请求扫库。
- 字段加权匹配：`name/original_name/personality` 权重更高。
- 排序优先级：优先 `name` 精确命中，再 `name` 前缀/包含，再其他字段。
- 查询归一化：大小写、重音符号统一。
- 多语言友好：对 CJK 文本增加字/双字切分。
