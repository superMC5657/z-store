# 参与开源广场

## 提交作品

1. 打开 [新建 Issue](https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml)，选择「开源广场投稿」。
2. 填写仓库地址、应用名称、分类和一句话自荐（上限 140 字，会折叠为单行）。英文自荐语可选，英文界面优先展示。
3. 选择档位：`free` 进入「最新上架」新品池；`spotlight-*` 申请顶部置顶推荐。
4. 提交后机器人会回复体检报告。若出现 `needs-changes`，按报告修改仓库或编辑 Issue，体检会自动重跑。
5. 维护者审核后打标上架，机器人会回复：
   - 广场直达深链 `zstore://launchpad/<id>`
   - 应用详情深链 `zstore://app/<id>`
   - 讨论帖链接
   - 可贴进 README 的徽章

## 置顶推荐

- 坑位最多 4 个，按到期时间自动释放；坑位已满时机器人会告知最早释放时间。
- 置顶作品与免费作品的准入门槛完全相同，置顶不影响 ZStore 精选目录与个性化推荐。
- 赞助凭证只填订单号或交易号后 6 位。Issue 是公开的，不要粘贴任何密钥、账号或个人信息。

## 修改数据

`launchpad.json` 由工作流维护，一般不需要手动编辑。确需修改时请发 PR，并确保下面两条命令通过：

```bash
npm run validate
npm test
```
