# assets/ - 本地素材目录

把所有要在 Excel 中引用的**参考视频**和**商品图片**直接放到本目录下。

## Excel 字段填写方式

| 字段 | 写法（推荐） | 等效写法 |
| --- | --- | --- |
| `referenceVideo` | `ref-video.mp4` | `/Users/.../assets/ref-video.mp4`（绝对路径） |
| `productImages` | `img1.png,img2.png,img3.png`（多张用英文逗号分隔） | 也可写绝对路径，混用 |

## 解析规则

后端 `POST /api/tasks` 收到任务后会做：

1. 路径以 `/` 开头 → 视为**绝对路径**，原样使用
2. 否则 → 拼接成 `<项目根>/assets/<你写的文件名>`
3. 解析后会**校验文件是否存在**，不存在直接 400 报错，避免任务跑到一半失败

## 建议

- 视频建议 `.mp4`，图片建议 `.png` / `.jpg`
- 文件名避免空格和中文（虽然系统支持，但 Excel 里容易复制出错）
- 一组商品可建子文件夹：`assets/productA/ref.mp4` → Excel 里写 `productA/ref.mp4`
