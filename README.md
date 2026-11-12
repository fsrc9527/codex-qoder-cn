# Qoder CN for Codex

把 Qoder 国服作为 Codex 里的可见子智能体。可以派任务、查看工具记录、在同一会话续问，也可以从 Codex 停止正在运行的任务。

需要本机 Codex、Node.js 22.13+（含 npm）和 [Qoder CN CLI](https://docs.qoder.cn/cli/installation)。已有 Qoder CN CLI 登录可直接使用，首次登录按安装提示操作。

下载源码后，在目录里运行

```sh
node install.mjs
```

安装程序会装好依赖、MCP、Skill 和 `Qoder CN` 子智能体。重启 Codex，在本地项目对话里试一下。

> `$qoder-delegate` 让 Qoder CN 只读查找登录入口，返回文件路径和行号。

在 Codex 的子智能体活动里打开 Qoder CN 即可查看或停止。也可以说「查刚才的 Qoder 执行记录」或「在同一个 Qoder 会话里继续问」。

有仓库访问权限时，也可以用 Git 和 npm 从 GitHub 直接安装。

```sh
npx --yes --package=git+https://github.com/fsrc9527/codex-qoder-cn.git codex-qoder-cn
```

任务默认只读，执行和续问使用你的 Qoder 账号额度。安装器将本地 `qoder` MCP 设为自动批准，遇到已有同名配置时会提示处理冲突。再次执行安装命令可更新。执行记录保存在 Codex 用户目录的 `qoder-cn/runs.sqlite`。
