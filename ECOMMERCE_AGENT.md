# 电商版 Agent 入口

先读 `docs/guide/ecommerce-unattended.md`；普通模式见 `docs/guide/ecommerce-zh.md`。

1. 先执行 `node bin/hypit.mjs ecommerce setup 工作目录`。首次必须问用户生图、生视频各选 API 还是原生，并提醒可选“拷问模式”；已有明确选择直接复用。API key 存在不代表选择 API，不默认切换兜底。
2. 拷问和卖点适配属于准备期。优先读产品档案，缺什么补什么，不在无人值守生产中循环提问或编造事实。模板是通用逻辑，取景、使用动作、对白随商品变化。
3. 普通模式走 plan→frames→检查/审批→videos→语音与剪辑核对→align→assemble。用户选择 native 时读取生成请求，调用当前真实工具，再 native-import；工具不存在就明确说明。
4. 用户要求无人值守时，准备产品×模板×重复数的有限 matrix，展示具体任务量，记录用户已有整批授权，再 matrix-check→matrix-run。不要为同一授权例行逐项提问；不得把示例数当真实生产指令。
5. API模式且视觉检查关闭时，生成、下载、ASR、字幕、配乐、合成和归档全部由脚本运行。开启视觉检查或选择原生能力时，无人值守必须先接好真实 hook；不伪造通过，也不擅自关闭检查。
6. 保留 receipts 和 calls；未知提交先核对，有任务号只恢复查询。默认不自动付费重试。失败款在报告中列出，其他款继续。
7. 生图 API 默认4K，视频720p/9:16；原生记录实际尺寸。密钥只留本地环境，不回显或提交 Git。APIMart上传/提交/查询统一按 APIMART_BASE_URL。
