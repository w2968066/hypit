# 电商版 Agent 入口

首次使用先读 `docs/guide/ecommerce-welcome.md`；无人值守见 `docs/guide/ecommerce-unattended.md`，普通模式见 `docs/guide/ecommerce-zh.md`。

制作或修改复刻模板之前，必须读 `skills/hypit/SKILL.md` 的 Understand and adapt / Direct the material，以及其 `references/creation/reference-video.md`、`references/playbooks/craft/image-direction.md`、`references/playbooks/craft/video-direction.md`。再读 `docs/guide/ecommerce-direction.md`。操作命令不能替代原版的导演分析。先看整片，按关键动作检查连续帧，记录事实，再适配产品；只有稀疏截图时不要声称已核实运镜或动作。

1. 首次执行 `node bin/hypit.mjs ecommerce welcome 工作目录`，一次向用户展示返回的一个问题，用 welcome-answer 记录实际回答，最后展示摘要、确认保存。已完成引导直接复用；旧配置的明确选择自动继承。无须让用户编辑JSON。API key 存在不代表选择API，不默认切换兜底。
2. 拷问和卖点适配属于准备期。优先读产品档案，缺什么补什么，不在无人值守生产中循环提问或编造事实。模板是通用逻辑；按用户的 strict/balanced/creative 复刻程度和 locks 调整商品相关内容。不得把关键回眸、走动或运镜随意改写。新模板记录 direction 与时间依据；旧模板允许运行但不能冒充严格复刻。
3. 普通模式走 plan→frames→检查/审批→videos→语音与剪辑核对→align→assemble。用户选择 native 时读取生成请求，调用当前真实工具，再 native-import；工具不存在就明确说明。
4. 用户要求无人值守时，准备产品×模板×重复数的有限 matrix，展示具体任务量，记录用户已有整批授权，再 matrix-check→matrix-run。不要为同一授权例行逐项提问；不得把示例数当真实生产指令。
5. API模式且视觉检查关闭时，生成、下载、ASR、字幕、配乐、合成和归档全部由脚本运行。开启视觉检查或选择原生能力时，无人值守必须先接好真实 hook；不伪造通过，也不擅自关闭检查。
6. 保留 receipts 和 calls；未知提交先核对，有任务号只恢复查询。默认不自动付费重试。失败款在报告中列出，其他款继续。
7. 生图 API 默认4K，视频720p/9:16；原生记录实际尺寸。密钥只留本地环境，不回显或提交 Git。APIMart上传/提交/查询统一按 APIMART_BASE_URL。
8. 基础版默认不向生视频接口传参考视频；本地分析原视频不等于上传。参考图1是当前镜头的起始画面，公共场景图只提供连续性，不覆盖该镜头取景。图像姿势必须与视频起点对应。
9. `frames` 返回 frame_review_required 时，只检查 ids 所列父图，用 `inspect run frames id1,id2` 和 inspect-result 记录后继续 frames；已通过且未改变的图不重复调用视觉模型。开关关闭则跳过视觉检查，保留脚本校验。
10. 质检失败先判断提示词、参考图还是生成偏差。不得自行循环重抽；无人值守失败项留档继续其他款。普通模式重做须已有明确的重试授权，先报告会连带失效的依赖。用 `diagnostics run` 查看耗时和重做记录；使用脚本并发，不另起多个进程绕过锁或任务预算。
