# 批量配置示例

将示例复制到实际工作目录再编辑；它们不包含用户选择或付费授权。
先用 setup 询问并保存实际生成方式。batch.example.json 的路径从文件所在目录解析，
原始仓库不包含个人参考视频或图片，需放入已制作模板和产品文件夹。

示例是2个模板、每个2次；产品文件夹有5款时输出20个。将 templates 填到5个就是50个。
visual_check:false 是显式速度模式示例，需符合用户选择；开启检查须有实际视觉适配器。
母女与棚拍的产品槽位可能不同，使用 products 显式列表里的 variants 或产品 adaptations
分别准备，不能假设同一份场景和对白适用于每个模板。

完整协议和命令见 `docs/guide/ecommerce-unattended.md`。
