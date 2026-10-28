# 复刻导演流程、速度与失败定位

电商层保留产品资料、模板复用和批量生产，模板制作采用 Hypit 原版的参考分析与素材导演方法。
当前执行仍是 ecommerce 脚本，尚未迁入原版 Runtime；本次不把改提示词宣称为完成引擎迁移。

## 制作一次，重复使用

Agent 先阅读 `skills/hypit/SKILL.md`，以及其 reference-video、image-direction、video-direction 指南。
完整看参考视频，再用本地 probe、切镜、连续抽帧定位动作和镜头变化；原版 `hypit media` 工具可用于这些步骤。
不要只凭一张截图推断走动、回眸或运镜。事实与产品适配分开保存，不在每个商品任务中重复拆片。
模型的提示词 Kit 只在匹配当前模型与任务时使用，不把 Seedance/GPT Image 的参数或措辞当作 Grok/Nano Banana 接口契约。

每个新模板镜头保留 start/end、frame、dialogue、prompt，并增加 direction。以下是**虚构结构示例**，不是对某条原片的分析；时间与动作需用实际观察替换：

```json
{
  "id": "s1", "start": 0, "end": 2, "frame": "side_start",
  "prompt": "供旧工具阅读的说明；有 direction 时视频动作由 direction 编译",
  "dialogue": "",
  "direction": {
    "evidence": "原片本镜头0–2秒连续帧中观察到的具体变化及核对依据",
    "start_state": "侧身迈步，目光向前",
    "action": "保持侧向走动，转头看向镜头",
    "end_state": "身体仍朝前，脸转向镜头",
    "camera": "平视横向跟拍，保持人物大小近似不变",
    "framing": "全身",
    "secondary_motion": "风将发丝和{{product}}下摆吹向左侧",
    "product_slots": ["product"],
    "key_moments": [{"at": 1.2, "action": "回眸与镜头短暂对视"}],
    "critical": ["action", "key_moments"]
  }
}
```

`at` 是镜头内秒数。必须有起始、过程、结束、运镜、景别、次级运动与关键时刻；确实无运镜/风时写明“无”。
`evidence` 保存原片观察，不填通用的“已审核”作为替代。结构校验不能证明 Agent 真的看过视频，不能自动验证所有自由文本矛盾。
`product_slots` 只用于商品、身体取景部位、操作对象等必要替换；不能把整段关键动作藏进一个可自由重写的槽位。
`critical` 是这个模板不可丢失的动作字段；需要不同动作的通用产品适配，应在模板设计时区分叙事作用与可替换操作。

生图按本镜头的起始状态与取景制作，不能一律套“全身入画”。同一首帧不能供不同起始姿态的镜头使用。
场景一致不等于所有镜头构图一致：公共锚图保存人物身份、光线和物理关系；分镜图决定本镜头取景。
模板的 `frames[].constraints`、`shots[].constraints` 只应用于对应镜头。全局 physical_anchors 只放共同有效的空间约束，
不要全局拼“全身”“脚踩地面”“不推拉”等局部取景要求。旧 focus_guard 仍兼容，升级时移入对应镜头。

## 复刻程度与产品适配

首次引导询问默认档位。产品 `fidelity` 或批次 `fidelity` 可覆盖已保存偏好：

```json
{"fidelity":{"mode":"balanced","locks":["camera","dialogue"]}}
```

| 档位 | 自动锁定 | 可以调整 |
| --- | --- | --- |
| strict | 全部 direction 字段及对白结构 | 声明的商品变量、人物、背景外观 |
| balanced | action、key_moments | 起止姿态、运镜、景别、次级运动，须记录理由 |
| creative | 模板 critical 与用户 locks | 其他 direction 字段，须记录理由 |

用户 locks 与模板 critical 始终有效，支持 direction 字段及用户 dialogue 锁。
任何档位均不自动切换模型、增加参考视频输入或保证生成模型百分百遵守。
跨品类时，商品部位可通过明确槽位由下半身改为上半身；如果必须改变已锁定的动作，解释冲突并由用户调整档位/要求，不能静默放宽。

变化写进 `product.adaptation.shots.<id>.direction`，附 `reason`，适配本身 `reviewed:true`。
有 direction 的镜头禁止用 adaptation.shots.<id>.prompt 整段覆盖。生图若要适配，用 adaptation.frames.<id>.prompt 与 reason；
脚本会附加对应视频的起始姿态与景别。对比原观察和适配结果，消除两者冲突后才生产。
每个 run 保存 adaptation-report.json，列出源方向、目标方向、锁定项、变更、变量和最终提示词。
提交前的 requests/ 保存实际提示词、参数及参考文件哈希，不保存密钥。

现有已编译模板继续可读、可运行，缺 direction 时明确标记“未核验复刻程度”；不能选择 strict 或附加 locks。
新 compile 必须具备 direction。不要从旧提示词自动补造“原片观察”，应重新核对原视频再升级模板版本。
已有 run 保持原请求编排以便续查；新 plan 使用 pipeline_version:2 的分镜首图优先策略。

## 少返工、按依赖并发

默认 execution 为 `{"jobs":2,"images":2,"videos":3}`，各值可设1–8。
批次中的 images/videos 是整批共享上限，不随 jobs 相乘。普通 run 按自身上限调度。
原生能力交接每个 run 一次一项；API 独立任务并发，父图先于子图。
同一执行过程中，相同平台、账号与文件的上传去重，缓存最长15分钟，不跨运行假定上传链接永久有效。

视觉检查打开时，父图通过后才派生子图，随后只检查新增或变化的图。检查结果绑定实际素材、产品参考与目标提示词。
普通流程的 frames 可能返回 frame_review_required；执行 `inspect run frames scene`，实际看图后通过 inspect-result 记录，再继续 frames。
无人值守由现有真实视觉 hook 完成相同关卡。关闭视觉检查则不调用视觉模型，脚本约束照常保留。

视频检查同时提供目标动作、关键时刻、预期剪辑窗口及对应抽帧。抽样看不清动作时应查看本地原片段，不能从几张静态图伪造运动检查通过。
无对白视频提示词要求在目标使用区间完成关键动作；这不是模型执行保证。
若正确动作在片段的另一个位置，视觉审核可返回 `trim:{"start":1,"duration":2}`，保持计划时长且不超出片段。
无人值守剪辑使用该已核实窗口；关闭视觉检查时仍从0秒取计划时长，不宣称已自动找到了关键动作。

## 失败与耗时

不自动付费重抽。审核失败先区分 prompt_conflict、wrong_reference、generation_error 或 uncertain。
没有证据时不要把失败全部归因于模型，也不要让质检模型借修图重新设计原片。
普通重做需已有明确授权，并查看 retry 返回的依赖影响；无人值守失败项留档，修复后建立新授权任务。
不在批次里执行 retry 绕过既定预算。未知提交不重发；有任务号先续查；并发请求全部结束后才释放项目锁。

`node bin/hypit.mjs ecommerce diagnostics run` 输出上传、生成、视觉 hook、剪辑和合成耗时，以及重做原因。
receipts 的 submitted_at/completed_at/downloaded_at 可区分平台等待与下载。
批次还保存每个 run 的 diagnostics.json。阶段时间可能相互包含或重叠，不能简单相加当总耗时；旧任务没有时间记录时不会编造耗时。
要调查第三方 Agent 是否遵守流程，比较模板、产品适配、plan、adaptation-report、requests、attempts 与 Agent 的实际工具记录。
