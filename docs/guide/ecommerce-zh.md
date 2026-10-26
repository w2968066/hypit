# 电商版 Hypit：给 Agent 的日常使用约定

默认生图走 Comfly Nano Banana 2.1，4K；基础版视频走 APIMart Grok，720p、9:16。
API 失败且结果明确时，Agent 检查当前是否有原生生图／生视频工具，有就接着使用。
实际原生尺寸会记录；没有对应工具就说明缺少能力。不会自动把 4K 改成 2K，或把插值图当 4K。

用户可以直接这样说：

> 用母女问链接模板，把这个产品文件夹里的商品做成基础版视频。先读已有产品资料，
> 缺少卖点才问我；开启视觉检查，使用我的音乐库，字幕留在抖音安全区。

## 从参考视频保存模板

向 Agent 提供本地视频和模板名字。Agent 读取画面与音轨，区分真实切镜和连续动作，
将原片的叙事、动作、角色、取景和音频类型写进 `analysis.json`，再执行 `compile`
保存正式 `template.json`、参考切片和来源音轨。整个版本目录可以打包迁移。
制作过程中不默认调用付费生图或生视频。参考素材和个人商品图保存在本机，代码仓库
保存制作母版与使用说明。

新增示例在 `examples/ecommerce-studio-motion/`：约8.4秒的单人棚拍，3个镜头，
逻辑为动态外形→换角度停稳→结构与表面细节。它没有商品口播，默认关闭对白字幕；
源片歌曲中的人声不作为角色台词。使用时须提供用户音乐库或明确选择的配乐。

## 产品资料与拷问

- `product.json` 放商品事实、参考图和这次的适配配置。
- `product.profile.json` 放可复用的资料和已核实问答；先读取，避免同样的问题反复问。
- `product-info product.json` 查询资料；用户忘记卖点时，先帮助回忆已有记录。
- 用户明确要聊透卖点时执行 `grill product.json`；每次只问一个有用的问题。
- “好看”“质量好”等回答需要追问具体表现和证据；已有明确事实不重复问。
- 用户结束测试就停下。未答完的记录保留为草稿，不能冒充已确认资料。

## 模板按逻辑复用

“同伴注意到商品→问来源→解释购买原因→展示细节→回到日常使用”是一套通用逻辑。
服装、食品、家居用品可以换角色、动作、镜头焦点和对白继续使用它。
运行 `adapt template.json product.json` 查看已有信息和缺失槽位。
`adaptation.slots` 和 `adaptation.shots` 保存确认过的适配；品类预设不是白名单。

## 视觉检查与局部重做

默认开启。Agent 执行 `inspect run frames` 或 `inspect run videos` 后，必须真正用可用的
视觉模型查看参考图和抽帧，再通过 `inspect-result` 记录结果。检查图案、颜色、纽扣、
人物与背景、穿模、肢体异常、坐姿支撑等。抽样不能保证每一帧都没有问题。

只在乎速度的用户可执行 `quality run off`；以后可用 `quality run on` 恢复。
关闭后跳过模型视觉检查。某镜头需要重做时：

```sh
node bin/hypit.mjs ecommerce retry run video s5 "句尾缺失"
node bin/hypit.mjs ecommerce videos run --submit
```

保留其他成功镜头；旧文件与任务记录留档。重做父首帧时，会连带更新依赖它的素材。
原 API 任务结果未知时先恢复查询，避免重复付费提交。

## 字幕、配乐和导出

用实际语音确认剪辑时长，完整台词优先；可以在 `edit.shots[].duration` 改时长，
不用修改生成计划。`align run edit.json` 运行本地语音识别，生成待核对的字幕时间。
核对后设置 `edit.captions.path` 和 `reviewed`，统一合成命令会压入字幕。
默认安全区在 720×1280 画面左留 42、右留 145、底留 315 像素，字号 38；可以调整。

用户自行筛选和预处理音乐。用 `edit.music_library.path` 指定目录，或设置
`HYPIT_ECOMMERCE_MUSIC_LIBRARY` 为绝对目录。每个产品随机选一首，保存副本与选曲记录。
同一个运行重新合成会沿用原曲，音乐不额外做情绪筛选。

`assemble run edit.json` 导出最终视频、字幕和交付记录；批量任务可用 `batch-assemble`。
更多参数见 [完整说明](ecommerce-basic.md)；本次样片经验见 [固化决策](ecommerce-decisions.md)。
