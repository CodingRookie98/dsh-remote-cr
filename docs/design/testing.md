# 测试体系：分层、门禁与「绿了不等于能用」

> 结论先行：**这套测试的目标不是覆盖率，而是让「装上就废」这类问题在提交前变红。**
> 0.4.0 的八轮对抗审查里，真正漏出去的缺陷没有一个是「某个函数算错了」，全是连线：夹具与线上形状脱节、用例走不到目标分支、门禁只扫了一半字段。

## 1. 分层

| 层 | 跑什么 | 命令 | 覆盖什么 | 例子 |
|---|---|---|---|---|
| **L0 类型与静态** | 双 tsconfig、补丁约束、文案门禁、错误码索引、文档图片 | `pnpm typecheck && pnpm check:boot && pnpm check:cjk && pnpm check:errors && pnpm check:docs` | 编译不过、行 id 不合法、界面里写死中文、码表漂移、文档断图 | `scripts/check-boot-constraints.mjs` |
| **L1 纯函数** | `node --test` 里的逻辑用例 | `pnpm test` | 决策、解析、格式化、状态迁移 | `src/shared/*.test.ts`、`src/local/migration/*.test.ts` |
| **L2 模块** | 注入依赖后的模块级用例 | `pnpm test` | 分支完整（成功 + 失败 + 边界） | `src/local/backend/ssh/{bootstrap,runtime,errors}.test.ts` |
| **L3 路由/接线** | 直调 handler + 断言线上形状 | `pnpm test` | 「注册对了没」「形状对不对」——`remote/version-mismatch` 这类幽灵码就死在这一层 | `src/local/routes.test.ts` |
| **L4 浏览器** | 真 Chrome + CDP，14 个场景 + 键盘链路 | `pnpm e2e:preview` / `pnpm e2e:host` | 渲染、布局、焦点、键盘可达、屏上是否漏译 | `scripts/preview-wizard.mjs` |
| **L6 不变量** | 「这类 bug 不许再出现」的通用断言 | `pnpm test` | 见 §2 | `src/client/invariants.test.ts` |

L4 需要真 Chrome，**不进 CI**（`ubuntu-latest` 没有 Windows/WSL2，挂上去只会得到永久红）；L0–L3 与 L6 全在 CI。

## 2. L6 不变量（当前三条）

| 编号 | 不变量 | 为什么钉它 |
|---|---|---|
| L6-1 | 每条 `err.*` 码都必须有 `errNext.*` 下一步 | 用户拿到码却不知道做什么 = 失败没响（铁律 4）。当前 66/66 |
| L6-2 | 复制日志渲染是纯函数：两次结果相同、不改输入（深冻结后不抛） | 渲染顺手改状态，是「偶发错乱」最难查的一类 |
| L6-3 | 本地化永不产出空串或 `undefined`；未知码整条回落到宿主原文 | 0.4.0 真栽过：`t(undefined)` 把原因行渲染成空白，而门禁只看 `text` 不看 `title` |

新增不变量时先问一句：**这条断言能不能抓到一个「功能还绿但用户已经不能用」的形状？** 抓不到就别加。

## 3. 三次假绿，各修了什么

| 事故 | 当时的状态 | 修法 |
|---|---|---|
| 预览夹具手搓旧形状 | 14 个场景「全通过」，而 5 个场景屏上印着 `sourceReason.undefined` | 夹具改用真实形状；harness 增加「屏上 undefined / 未翻译键」门禁（`text` 与 `title` 都扫） |
| 「真路径」用例其实没走到分支 | `beginFlow(initialWizard())` 因 `step==='closed'` 直接 return，删掉被测代码用例照样绿 | 改用 `openWizard(initialWizard())` 并断言 `flow !== null`；**并用变异测试反证**（删掉实现 → 用例必须红） |
| 文档图片断链 | 只会在有人点开时发现 | `pnpm check:docs`：存在性 + 真 PNG + 尺寸下限 + 覆盖率 |

共同点：**都在「门禁认为自己检查了」的地方漏的**。所以改门禁时要做一次变异（把被测物改坏，确认门禁真的红），否则等于没加。

## 4. 怎么加测试

1. 先定层：能用纯函数测的，别拖到 L4；需要「注册/形状」的，写 L3；
2. 失败路径优先：成功路径通常写一遍就过，失败路径才是用户真正会遇到的；
3. 涉及远端行为的，补一条真机探针（`spikes/`），并在 PR 里贴输出；只写 mock 的会被要求补证据；
4. 新错误码：`locales.ts` 里 `err.*` 与 `errNext.*` 成对加，跑 `pnpm gen:errors` 更新排查手册；
5. 新界面文案：只进 `locales.ts`，`pnpm check:cjk` 会拦住写死中文。

## 5. 覆盖率（基线，2026-11-18）

`pnpm coverage` 用的是 **Node 自带的 `--experimental-test-coverage`**，不引第三方工具（也就没有「覆盖率工具本身要维护」的成本）：

```
node --test --experimental-test-coverage "src/**/*.test.ts"
all files | 88.48 % 行 | 83.55 % 分支 | 87.02 % 函数
```

**怎么读这个数字**：`src/shared` 与 `src/local/backend/{ssh,wsl}` 的关键模块在 95–100 %；低的地方集中在两处——

1. **`src/client/panel*.ts`**：它主要是渲染接线，单测只覆盖到「本地化与文案」这一层，真正的渲染由 L4 的 CDP harness 兜（覆盖率工具看不到浏览器那一半）；
2. **极少走的错误分支**（例如 `i18n.ts` 的回落链）：有断言但没走到全部路径。

**因此覆盖率不作为门禁**：门禁是 L0 的静态检查、L4 的场景与 L6 的不变量。覆盖率只用来发现「整块没测」，不是「每行都测」的许可。

## 6. 与交付门禁的关系

`docs/` 里的验收口径（见 [AGENTS.md §5](../../AGENTS.md)）要求：关键路径有真机证据、失败路径有测试、文档随代码更新。
本页是「测试怎么写」的说明书；**交付前必须跑的是** `pnpm typecheck && pnpm test && pnpm check:boot && pnpm check:cjk && pnpm check:errors && pnpm check:docs && pnpm build && pnpm build:client`。