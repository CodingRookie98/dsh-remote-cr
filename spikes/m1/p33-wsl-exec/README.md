# P3.3 / P3.5 真机探针：WSL 调用层与 UNC 直挂

> **结论先行**：M1 的两个实现地基在**本机真机**上成立 —— ① `wsl.exe` 的**管理类输出是 UTF-16LE 无 BOM、`--exec` 输出是 UTF-8**，两套解码器分开后发行版枚举、路径、退出码、stderr 分离、stdin 全文全部实测通过（8/8）；② **UNC 就是本机真实目录**，`realpath` / `stat` / 双向读写 / `--exec cat` 降级等价全部实测通过（6/6）。两条都有可假性负控（8/8 → 5/8、6/6 → 1/6）。

## 为什么需要这两个探针

`src/local/backend/wsl/` 的所有解析逻辑都写成了纯函数（`distro.ts` / `unc.ts`），单测在
任何机器上都能跑；但**它们成立的根据在 Windows + WSL 上**，只能真机证明。按仓库约定
（`spikes/README.md`）：docs 只放文档，可执行的东西放 spikes，断言必须可假。

## 复跑命令

```bash
# 正向：必须 8/8 与 6/6
node spikes/m1/p33-wsl-exec/probe.cjs
node spikes/m1/p33-wsl-exec/unc-probe.cjs

# 负控：必须变红（8/8 → 5/8、6/6 → 1/6）
NEGATIVE_CONTROL=1 node spikes/m1/p33-wsl-exec/probe.cjs
NEGATIVE_CONTROL=1 node spikes/m1/p33-wsl-exec/unc-probe.cjs
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_DISTRO` | `ubuntu_dev` | 目标发行版名（**允许含空格/中文**，调用时作为一个 argv 元素传） |
| `DSH_WSL_EXE` | `wsl.exe` | wsl 可执行文件路径 |

## 实测输出（2026-10-31，基线机）

```
==> P33-1/2 发行版枚举（wsl.exe --list --verbose）
  PASS P33-1 head=200020004e0041004d004500 u16=true utf8HasNul=true
      parsed: {"name":"ubuntu_dev","state":"Running","version":2,"isDefault":true}
  PASS P33-2 ubuntu_dev state=Running version=2 default=true
==> P33-3/4 --exec 派发语义
  PASS P33-3 pwd="/mnt/d/workspace/projects/dsh-remote-cr" exit=0
  PASS P33-4 Linux CodingRookie 6.18.54.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Tue
==> P33-5/6 退出码与 stderr 分离
  PASS P33-5 exit=7
  PASS P33-6 stdout="out" stderr="err"
==> P33-7 stdin 全文可达
  PASS P33-7 len=4111
  PASS P33-8 statusLen=52

--- 8/8 passed, 0 failed ---
```

```
==> 远端 HOME = /home/hui（exit=0）
==> UNC-1/2 realpath 与 stat
  PASS UNC-1 realpath=\\wsl.localhost\ubuntu_dev\home\hui\.dsh-teleport-unc-probe
  PASS UNC-2 isDirectory=true
==> UNC-3 双向读写
  PASS UNC-3 bytes=55 一致=true
==> UNC-4/5 --exec cat 降级路线等价
  PASS UNC-5 {"distro":"ubuntu_dev","posixPath":"/home/hui/.dsh-teleport-unc-probe/marker.txt"}
  PASS UNC-4 exit=0 bytes=55 一致=true
==> UNC-6 不存在的路径必须抛 ENOENT（证明上面不是真空通过）
  PASS UNC-6 code=ENOENT

--- 6/6 passed, 0 failed ---
```

## 可假性（负控做了什么）

| 探针 | 负控手法 | 期望 | 实测 |
|---|---|---|---|
| P33 | 管理类输出改用 UTF-8 解、`--exec` 输出改用 UTF-16LE 解 | P33-1/2/3 变红 | 8/8 → **5/8**，失败集 `P33-1, P33-2, P33-3` |
| UNC | 把 distro 名改成不存在的 `ubuntu_dev-no-such-distro` | UNC-1..5 全部变红 | 6/6 → **1/6**，只剩 UNC-6（它本就是「不存在路径」的断言） |

负控**不改断言**、只改被测量：如果断言是空的，负控就会照旧全绿——这正是它要抓的东西。

## 关键结论（可直接引用的实现约束）

1. **两套解码器不能混用**。管理类（`--list` / `--list --verbose` / `--status`）是 UTF-16LE 无 BOM（首 12 hex = `200020004e0041004d004500`，即带前导空格的 ` NAME`）；`--exec` 输出是 UTF-8。混用的表现分别是 `u\0b\0…` 与 `洯瑮搯…`（后者在本次负控里真实出现：`pwd="洯瑮搯眯牯獫慰散瀯潲敪瑣⽳獤⵨敲潭整挭ੲ"`）。所以 `exec.ts` 保留**原始字节**，由各入口决定解码。
2. **`--exec` 的退出码与 stderr 原样透传**（`exit 7` → 7；`echo err >&2` 只出现在 stderr），失败分类因此可以建立在退出码上。
3. **stdin 全文可达**（4111 字节的标记载荷原样回来），这是 `cat >` 写入回退与 stdio 桥的前提。
4. **UNC 双向可用**：写进去、读回来一致（含中文 UTF-8），`fromUnc` → `--exec cat` 读到的内容逐字节相同 ⇒ 降级路线与主路线等价，投影层可以放心用 UNC 作主路径。
5. **发行版名允许含空格**：`--list --verbose` 必须按 `/\s{2,}/` 切列并从右往左取 STATE/VERSION，剩下的整段才是名字；按单空格切会把 `Ubuntu 22.04 LTS` 切碎。
6. **中文表头要显式跳过**：`/^(NAME|名称)(\s|$)/` —— 用 `\b` 不成立（CJK 属 `\W`，后面跟空格时无词边界），中文表头会被当成一条发行版。这是本次写测试时真踩到的坑。

## 已知未覆盖

- **NAT 模式**：本机是 WSL **mirrored**，NAT 下的通路行为未测（改 `.wslconfig` 影响宿主全部 distro，M1 不做）。
- **`wsl.exe --exec` 的并发上限**：多个会话同时挂 stdio 桥时是否撞句柄上限，A11 只测了单桥。
- **非 Ubuntu 发行版**：只实测 `ubuntu_dev`（glibc 2.39）。alpine/musl 未测。
