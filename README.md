# dsh-client-fix

> **作用**：DSH Desktop 客户端一键修复插件——自动修复 pnpm shim 中文路径乱码（"系统找不到指定的路径"）、
> 让 web profile 无延迟自动跟随 desktop 的插件变化（向 desktop 对齐）、安装前自动预加
> minimumReleaseAgeExclude 豁免，市场更新即同步，无需手动干预。
>
> **使用 DeepSeek-V4-Flash 制作** 🤖

DSH Desktop 客户端修复插件（client-side fix plugin）。

## 功能

1. **修复 pnpm shim 编码 bug**
   DSH Desktop 启动时生成的 `runtime-commands/bin/pnpm.cmd` 以 UTF-8 写入，但 cmd.exe 按 GBK(936) 读取，
   导致含中文的路径（如 `D:\软件\...`）解析乱码，报"系统找不到指定的路径"。
   插件启动 3 秒后自动给 shim 第二行补 `chcp 65001 >nul`（无 BOM），跨代码页通用。
   桌面应用重启重新生成坏 shim 后，插件会自动再次修复。

2. **fs.watch 无延迟自动同步 web（向 desktop 对齐）**
   监听 desktop profile 的 `package.json` 与 `pnpm-lock.yaml`，变化后（防抖 800ms）自动把 web profile
   同步成与 desktop 一致：
   - desktop 有、web 无 → 补装
   - desktop 无、web 有 → 移除（尊重手动卸载）
   - 版本不同 → 对齐 desktop 版本
   市场（dshmarket）更新只操作 desktop，web 由本插件自动跟随，无需手动操作。

3. **预加 minimumReleaseAgeExclude 豁免**
   安装前自动把 `pkg@version` 写入 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，
   避免 pnpm 拦截 24 小时内发布的新包（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。

## 安装

```bash
# 在无空格路径下（含空格路径会被 dsh→pnpm 转发截断）
cd C:/dshplugins
dsh plugin --profile desktop add ./dsh-client-fix
dsh plugin --profile web add ./dsh-client-fix
```

## 接口

| 路由 | 说明 |
| --- | --- |
| `/dsh-client-fix/status` | 查看 desktop/web 插件版本对比与同步状态 |
| `/dsh-client-fix/sync` | 手动触发一次同步（向 desktop 对齐） |
| `/dsh-client-fix/repair-shims` | 手动修复 pnpm/node shim 编码 |

## 许可证

MIT
