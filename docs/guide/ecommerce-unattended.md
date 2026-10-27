# 首次设置与无人值守生产

普通模式仍逐阶段审核；无人值守模式在启动前一次确定商品资料、模板适配、生成方式、视觉检查和调用上限，随后执行固定脚本。不会在运行中重新拷问用户或自由推理修改卖点。

## 首次使用

推荐使用[中文逐题引导](ecommerce-welcome.md)：`ecommerce welcome 工作目录`，由Agent一次问一题；终端可加 `--interactive`。以下 setup JSON 入口保留给已有自动化和直接配置使用。

Agent 首先执行 `node bin/hypit.mjs ecommerce setup 工作目录`，把返回的问题和可选拷问模式提醒告诉用户。
分别询问生图和生视频选 API 还是当前 Agent 的原生能力，并询问是否允许 API 明确失败后使用原生能力。**有 token 不等于用户选择了 API。** 已有明确选择则沿用，不重复询问。

把用户实际回答写入 `choices.json`，示例如下；`evidence` 应记录真实回答，不能把示例当用户授权：

```json
{
  "generation": {
    "image": "api",
    "video": "api",
    "fallback": {"image": false, "video": false},
    "evidence": "替换为用户实际选择的记录"
  },
  "grill_reminder_acknowledged": true
}
```

```sh
node bin/hypit.mjs ecommerce setup 工作目录 choices.json
```

设置保存在该工作目录的 `ecommerce-settings.json`。从此目录执行普通 `plan` 时自动读取；产品也可用 `generation` 保存自己的明确选择。新批次可用同名字段覆盖设置。
没有选择时允许先准备普通计划，但禁止提交生成。旧运行目录可用 `route run-dir choices.json` 补选择；计划改变后需要重新审批首帧。
首次帮助输出也会提醒拷问模式；确认告知后不会反复提醒。拷问可选，现有产品档案优先复用。

## 准备多个产品和模板

每款一个文件夹，包含 `product.json`、图片和可复用的产品资料。Agent 先读取已有资料，根据已知卖点一次性完成各模板适配，缺失或不确定事实在启动前处理。
商品特有的取景和动作必须更新：裤子拍腰头/裤腿，开衫拍门襟/上半身；非服装改为持握、使用和实际证明。模板叙事通用，品类不是白名单。

`batch-spec.json`：

```json
{
  "schema": "hypit.ecommerce.matrix-input.v1",
  "products_dir": "products",
  "templates": [
    "templates/template-a/template.json",
    {"file": "templates/template-b/template.json", "background_pool": ["室内布景一", "室内布景二"]}
  ],
  "repeat": 2,
  "visual_check": false,
  "music_library": {"path": "music-library", "gain": 0.18}
}
```

相对输入路径从 spec 所在目录解析。这里显式关闭视觉检查作为速度模式示例；默认开启，开启时需要下文的真实视觉接口。音乐由用户筛选预处理，程序随机选取并保存记录，不做情绪筛选。
普通生图 API 默认4K，视频720p、9:16。原生结果记录实际尺寸，原生能力不会随项目源码一起安装。

`products_dir` 扫描一级商品子文件夹。也可改成显式列表，并为同一商品的不同模板指定准备好的产品文件：

```json
{
  "products": [
    {
      "file": "products/开衫/product.json",
      "variants": {"studio-motion-detail": "product-studio.json"}
    }
  ]
}
```

`variants` 的相对路径从该商品主 product.json 所在目录解析。另一种方式是在产品里保存 `adaptations[模板id]`，内容与已有 `adaptation` 一样，包含 `reviewed:true`、`slots` 和可选 `shots`。
不要让一个模板的场景或对白覆盖另一个模板。缺少槽位、未审定资料、重名输出目录会在准备阶段报错，尚未提交付费生成。

## 一次启动

```sh
node bin/hypit.mjs ecommerce matrix batch-spec.json new-batch
node bin/hypit.mjs ecommerce matrix-check new-batch
# 用户已经要求执行这个具体有限批次时，记录已有授权，不必例行重复询问：
node bin/hypit.mjs ecommerce matrix-authorize new-batch "真实的整批无人值守授权记录"
node bin/hypit.mjs ecommerce matrix-run new-batch --submit
node bin/hypit.mjs ecommerce matrix-status new-batch
```

`matrix` 仅生成计划，列出商品数、模板数、重复数、总成片数、首帧任务数、视频任务数和生成秒数。5款×5模板×2次就是50个独立运行，**不意味着只调用50次视频 API**；每个模板有自己的分镜数。
`matrix-check` 检查配置、FFmpeg、FFprobe、音乐库、语音识别和接口能力，不提交生图或生视频。
口播模式需要本地 Python，执行 `python -m pip install -r scripts/ecommerce/requirements-asr.txt` 安装 faster-whisper 和 pypinyin。提前缓存模型，避免无人值守时才下载。

启动后：串行锁景生图→可选模型视觉检查→自动首帧放行→生视频→可选视频抽样检查→本地对白核对→字幕、音乐、合成→商品归档。自动放行明确记录为 automation，不冒充人工看图。
初版串行排队，每个输出只走有限节点；默认不自动付费重试，不会产生无限重做循环。

```text
new-batch/
  matrix.json             固定计划与调用上限
  authorization.json      整批授权及计划摘要
  calls.json              API/原生生成调用预留记录
  state.json              持久状态
  report.json             每款成功、失败、原因和产物清单
  runs/原商品文件夹/模板id/v001/   素材、任务收据、质检、剪辑和音乐记录
  videos/原商品文件夹/模板id/
    v001.mp4
    v001.srt              有字幕时导出
    v002.mp4
```

每个重复项真实重新生成，不能复制同一个视频凑数。可配 `background_pool` 轮换场景，并保留物理锚点。模型不保证每个版本都有明显差异，也不保证通过平台相似性判断。

## 上限、失败与恢复

- `limits.image_calls`、`limits.video_calls` 可设置生成次数上限；默认覆盖初始任务及明确允许的一次原生兜底。API 和原生调用都计数。它是次数限制，**不是人民币报价或平台账单**。
- `limits.minimum_free_bytes` 设置启动时的磁盘余量下限，默认512MiB；这是最低门槛，不是整批磁盘用量预测。
- 同一条请求结果未知，记录为 blocked，跳过后续提交；有任务号的请求保留为 waiting，再次 `matrix-run` 恢复原任务查询，不能重新 POST。
- 明确失败、质检不通过或语音不可信的款记入报告，其他款继续。终止失败行后续启动也不会自动重做，避免隐含追加费用。需要重做时在相应运行目录使用已有 `retry`/分阶段命令，明确授权新增调用；普通命令的导出记录与整批报告应分别核对。
- 完成项凭文件校验值复用；删掉导出副本可从已完成原片恢复。已有不同内容的成片不会覆盖。
- 在批次根目录放置名为 `STOP` 的文件，会在下个提交/任务边界停止新生成；正在提交或查询的任务不会被假装取消。删除 STOP 后再次 `matrix-run` 继续。
- 准备后修改计划、参考图、路线或视觉策略会拦截运行；应创建新批次。批次执行目录当前固定，不直接移动后续跑。
- 进程被强杀后的锁文件要先确认原进程已经结束再清理；不要为了重新提交而删除任务收据或调用预留记录。

## 无人值守的原生能力与视觉检查

API 模式、视觉检查关闭时，可由纯 Node 脚本完成生产。原生生成和视觉模型属于调用方 Agent 的真实能力，不能靠 Node 假装存在。
交互模式由当前 Agent 接手 `native_fallback_required` 和 `inspect`；无人值守模式需要一个能实际执行相应能力的本机适配器：

```json
{
  "hook": {
    "command": "node",
    "args": ["my-agent-adapter.mjs"],
    "timeout_ms": 600000
  }
}
```

程序以无 shell 的子进程调用：`command ...args request.json response.json`，工作目录默认 spec 所在目录。
适配器读取请求，写响应文件；stdout/stderr 不转发到批量日志，凭据不放请求或响应。超时不能被当作可安全重复生成。

```json
{
  "schema": "hypit.ecommerce.hook-request.v1",
  "kind": "capabilities",
  "request_digest": "实际摘要",
  "payload": {"required": ["native:image", "native:video", "quality"]}
}
```

响应统一为 `{"request_digest":"原摘要","result":...}`，三个 kind：

| kind | payload | result |
| --- | --- | --- |
| capabilities | 必需能力列表 | `{"capabilities":["native:image","native:video","quality"]}`，只报告确实可用的能力 |
| native | 静态提示词、参考图绝对路径、尺寸、镜头、原任务关联 | `{"file":"生成产物绝对路径","evidence":"真实调用证据"}` |
| quality | 实际图片/视频抽帧、产品参考图、检查清单、资产摘要 | 与 `inspect-result` 相同的 stage、digest、items，其中每项包含 id、passed、findings、evidence |

原生导入会校验参考图、计划、比例和时长；对话视频必须有音轨。视觉接口必须真正查看媒体，不能把文件存在当作看过。
项目提供协议和调度器，**没有内置适用于所有 Agent 的原生/视觉工具桥**。缺少接口会在付费生成前阻止无人值守启动，不会偷偷关闭视觉检查或切换平台。

## 哪些还需要 Agent

| 阶段 | 执行方 | 是否每个视频消耗 Agent 推理 |
| --- | --- | --- |
| 理解参考视频、确定叙事、制作通用模板 | Agent，制作期一次完成；切片/抽帧由脚本执行 | 否 |
| 选择 API/原生、首次提醒、可选拷问和资料存档 | Agent 与用户，复用已确认资料 | 否 |
| 把产品事实适配到模板槽位和镜头焦点 | Agent，启动前按产品/模板准备一次 | 否；重复份数复用准备结果 |
| 组合展开、路径检查、调用计数、API上传/提交/轮询/下载 | Node固定脚本 | 否 |
| 锁景继承、收据、断点恢复、失败隔离、随机配乐、归档报告 | Node固定脚本 | 否 |
| 对白识别、句尾与相似度核对、字幕时间、安全区、FFmpeg合成 | 本地Python/Node/FFmpeg | 否；占用本机算力 |
| 可选穿模/商品保持检查 | 实际视觉模型 | 是；关闭即跳过 |
| 选择原生生图/生视频 | 调用方原生工具或其适配器 | 取决于宿主工具；脚本不创造能力 |

自动字幕使用确认台词和实际识别时间；中文按无声调拼音对齐，容错开衫/开山等同音识别错误和常见繁简差异，同时保留原始文字相似度供核查。拼音转换使用 [pypinyin](https://pypi.org/project/pypinyin/) 的逐字结果；这不等于语义审查。默认音节相似度≥0.85、覆盖率≥0.90，且末尾四个音节匹配。实际对白不足时宁可报告失败，也不把未说出来的句尾塞进字幕。阈值不是质量保证，产品专有词可能造成保守拒绝。
