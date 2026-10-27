# 首次使用引导

让 Agent 读取本项目后说“开始首次使用引导”即可。Agent 执行：

```sh
node bin/hypit.mjs ecommerce welcome 工作目录
```

每次只展示返回的 `question`，用户回答后记录：

```sh
node bin/hypit.mjs ecommerce welcome-answer 工作目录 image api
```

下一题会自动返回，不要求用户编辑 JSON 或记住命令。依次选择：

1. 生图：API 或 Agent 原生能力。
2. 生视频：API 或 Agent 原生能力。
3. 使用 API 时，明确失败后是否允许原生兜底。
4. 产品资料：优先拷问卖点，或直接用已有资料。
5. 视觉检查：开启，或关闭以优先速度。
6. 音乐库文件夹，或暂时跳过。
7. 默认逐步审核或无人值守流程。
8. 查看摘要，确认保存。

原生能力须由当前 Agent 确认实际存在；引导不会创造或安装原生工具。无人值守的原生和视觉检查接口要求沿用原规则。
API 默认图片4K、视频720p/9:16。不要在引导中索取或回显密钥，密钥仍从本机环境读取。

普通终端可以直接操作：

```sh
node bin/hypit.mjs ecommerce welcome 工作目录 --interactive
```

不带子命令的 `node bin/hypit.mjs ecommerce` 也会进入引导；真实终端显示中文问答，Agent通过命令执行时返回结构化下一题，不会卡住等待键盘。
内部包的用户还可双击“首次使用引导.cmd”，或运行 `node agent.mjs`。Linux/macOS使用 `node agent.mjs welcome . --interactive`。

未完成的回答保存在 `.ecommerce-onboarding.json`；Ctrl+C可暂停，下次继续。保存前只记录草稿，当前设置保持不变；引导不会发起付费生成，也不会授权将来的批次。
确认后保存到 `ecommerce-settings.json`，下次直接复用。旧版已经确认的生成方式也会自动继承，不重复询问。

修改某一项：

```sh
node bin/hypit.mjs ecommerce welcome-answer 工作目录 quality off
# 查看摘要后确认
node bin/hypit.mjs ecommerce welcome-answer 工作目录 confirm save
```

`image`、`video`、`fallback`、`intake`、`quality`、`music`、`workflow` 是稳定的步骤ID。
全部重新逐项填写可加 `welcome 工作目录 --edit`，确认前原配置仍然有效。

保存的视觉检查和音乐库会用于之后的计划；单产品配置、批次配置和剪辑配置中的明确值优先。
选择稍后设置音乐库不会阻塞引导，纯配乐模板在生产前仍需要有可用音乐。
拷问与默认流程是给Agent的准备偏好：已有产品档案优先复用，拷问不会混入无人值守运行期；切换流程或单次覆盖无需重做引导。
