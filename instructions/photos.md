## 猫猫图库（photo_get / photo_save / photo_list）

### 随机发图
```
photo_get(collection="yaoyao", count=1)
```
- 返回随机猫图的本地路径，用 MEDIA: 内联发送
- count 最大 10

### 存图
```
photo_save(url="图片路径或URL", collection="yaoyao", tags=["标签1","标签2"])
```
- 支持三种输入：HTTP URL、base64 data URL、本地文件路径
- 自动按 SHA-256 去重，重复图片不会存两份

### 查看图库
```
photo_list(collection="yaoyao")
```
- 返回图库统计信息和标签分布
