import type { SshTarget } from './config.ts';
/** 与 package.json 的 engines 保持同一句话；两处不一致时以 package.json 为准（有测试对照）。 */
export declare const NODE_ENGINE_HINT = "^22.19.0 || >=24.0.0";
export declare const DSH_ENGINE_HINT = ">=0.2.1-rc.0 <0.3.0";
/** 远端没有 node 时安装的版本（与 M1 真机验证过的版本一致）。 */
export declare const DEFAULT_NODE_INSTALL_VERSION = "v24.22.1";
/**
 * 宿主的 npm 包名。**必须带 scope**：npm 上无 scope 的 `dsh` 是另一个人写的 JS shell
 * （infusion/node-dsh，描述是 'A shell written in JavaScript'）。2026-11-12 真机首跑就是
 * 照 `dsh@latest` 装的，装完 `npm/lib/node_modules/dsh/package.json` 里写着 "shell"，
 * 而我们的检查只看 `<prefix>/bin/dsh` 存不存在——于是「装好了」但装的是别的软件。
 */
export declare const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
export declare const STAGING_DIR_NAME = "staging";
export declare const BOOTSTRAP_STATE_FILENAME = "state.json";
export declare const BOOTSTRAP_STATE_VERSION = 1;
export interface Version {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: readonly string[];
}
/** 解析 `v24.22.1` / `24.22.1` / `0.2.1-rc.5` / `0.2.1-rc.5+build`；解析不了返回 undefined。 */
export declare function parseVersion(value: string | undefined): Version | undefined;
/** `compareVersions('0.2.1-rc.10','0.2.1-rc.5') > 0`；任何一侧解析不了就抛错（不猜）。 */
export declare function compareVersions(left: string, right: string): number;
/** `^22.19.0 || >=24.0.0`。 */
export declare function nodeSupported(version: string | undefined): boolean;
/** `>=0.2.1-rc.0 <0.3.0`。 */
export declare function dshSupported(version: string | undefined): boolean;
export interface BootstrapFacts {
    readonly node: string | undefined;
    readonly dsh: string | undefined;
}
export interface BootstrapDecision {
    readonly needNode: boolean;
    readonly needDsh: boolean;
    readonly reasons: readonly string[];
}
/**
 * 决定远端要不要装东西。
 *
 * 只回答「装不装」，不回答「怎么装」——装法是 `planBootstrap` 的事。
 * 版本不在范围内一律按「没有」处理，但理由分开写：用户看到「版本过低」和看到
 * 「没装」会采取完全不同的动作。
 */
export declare function decideBootstrap(facts: BootstrapFacts): BootstrapDecision;
export interface BootstrapStepRecord {
    readonly at: string;
    readonly detail: string;
}
export interface BootstrapState {
    readonly version: number;
    readonly targetId: string;
    readonly steps: Readonly<Record<string, BootstrapStepRecord>>;
    readonly mirror?: string;
}
export declare function emptyBootstrapState(targetId: string): BootstrapState;
export type BootstrapStateProblem = 'state-unreadable' | 'state-corrupted' | 'state-unsupported-version' | 'state-invalid';
export type BootstrapStateLoad = {
    readonly ok: true;
    readonly state: BootstrapState;
} | {
    readonly ok: false;
    readonly problem: BootstrapStateProblem;
    readonly message: string;
};
/** 解析落盘的断点账本；**坏记录不当空账本**，否则重装会从第一步重来。 */
export declare function parseBootstrapState(value: unknown, targetId?: string): BootstrapStateLoad;
export declare function readBootstrapState(file: string, targetId?: string): Promise<BootstrapStateLoad>;
export declare function writeBootstrapState(file: string, state: BootstrapState): Promise<void>;
/** 记一步完成；返回新对象，不改入参（断点账本要能随时回滚到上一份）。 */
export declare function markStep(state: BootstrapState, step: string, detail: string, at?: string): BootstrapState;
export declare function stagingDirFor(homeDir: string, target: SshTarget): string;
export declare function bootstrapStatePathFor(homeDir: string, target: SshTarget): string;
export type BootstrapStepId = 'staging' | 'tar' | 'node' | 'dsh';
export interface BootstrapStep {
    readonly id: BootstrapStepId;
    readonly title: string;
    /** 交给远端 shell 的脚本正文（单引号会被 shellQuote 处理，这里只管正文）。 */
    readonly script: string;
    /** 就地复用：账本里已有这步且产物版本对得上时给理由。 */
    readonly reuseReason?: string;
}
export interface BootstrapPlan {
    readonly decision: BootstrapDecision;
    readonly stagingDir: string;
    readonly steps: readonly BootstrapStep[];
    readonly skipped: readonly {
        readonly id: BootstrapStepId;
        readonly reason: string;
    }[];
    readonly mirror: string | undefined;
}
export interface MirrorCandidate {
    readonly name: string;
    readonly registry: string;
}
/** 默认三个 npm 源：官方、npmmirror、腾讯云镜像。 */
export declare const DEFAULT_MIRRORS: readonly MirrorCandidate[];
export interface MirrorMeasurement {
    readonly mirror: MirrorCandidate;
    /** 毫秒；undefined 表示不可达（超时/拒绝）。 */
    readonly ms: number | undefined;
}
/** 取最快的**可达**源；全都不可达返回 undefined（交给调用方硬失败，不猜一个）。 */
export declare function pickMirror(measurements: readonly MirrorMeasurement[]): MirrorCandidate | undefined;
export declare function summarizeMirrors(measurements: readonly MirrorMeasurement[]): readonly string[];
/** 私有 staging 目录：0700，绝不落 /tmp（/tmp 会被清理、也可能被同机他人读到）。 */
export declare function buildStagingScript(stagingDir: string): string;
/** `tar` 预检：缺 tar 就当场失败并打标记，而不是等解包时给一条看不懂的报错。 */
export declare function buildTarPrecheckScript(): string;
export interface NodeRuntimeRequest {
    readonly stagingDir: string;
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly downloadBase?: string;
}
/** node 官方分发包的文件名（linux-x64 / linux-arm64 / darwin-x64 …）。 */
export declare function nodeTarballName(version: string, platform: string, arch: string): string;
export declare function buildNodeRuntimeScript(request: NodeRuntimeRequest): string;
export interface DshPackageRequest {
    readonly registry: string;
    readonly dshHome: string;
    readonly version?: string;
    /** npm 前缀：装进 staging 而不是系统目录（普通用户身份也能装）。 */
    readonly prefix?: string;
    /** node 的 bin 目录（`staging/bin`）：npm 在那里，**不是** prefix/bin/npm。 */
    readonly nodeBin?: string;
}
/**
 * 装 dsh：npm 前缀写进 staging，DSH_HOME 指到固定的 home 路径（不塞 /tmp）。
 *
 * 必须带 `--prefix`：远端通常不是以 root 登录，`--global` 会去写 /usr/local 然后 EACCES；
 * 写进 staging 之后这份安装是可删的、可复现的，也不会污染目标机已有的 node 生态。
 */
export declare function buildDshPackageScript(request: DshPackageRequest): string;
export interface PlanBootstrapRequest {
    readonly facts: BootstrapFacts;
    readonly state: BootstrapState;
    readonly stagingDir: string;
    readonly nodeVersion?: string;
    readonly dshVersion?: string;
    readonly mirror?: string;
    readonly platform?: string;
    readonly arch?: string;
    readonly downloadBase?: string;
    readonly dshHome?: string;
}
/**
 * 排一遍要跑什么。
 *
 * 断点账本里已经做完、且产物版本仍然对得上的步骤不再排进来——但 staging 与 tar 这
 * 两步永远排（它们便宜，而且远端可能被人删过目录），重复执行是幂等的。
 */
export declare function planBootstrap(request: PlanBootstrapRequest): BootstrapPlan;
export interface StepOutcome {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
export type BootstrapRunner = (script: string) => Promise<StepOutcome>;
export interface BootstrapOutcome {
    readonly ok: boolean;
    readonly executed: readonly BootstrapStepId[];
    readonly failed: {
        readonly id: BootstrapStepId;
        readonly code: number;
        readonly tail: string;
    } | undefined;
}
/** 顺序执行；**任一步失败就停**（后面的步骤都依赖前一步的产物，硬着头皮跑只会掩盖根因）。 */
export declare function runBootstrap(plan: BootstrapPlan, run: BootstrapRunner): Promise<BootstrapOutcome>;
//# sourceMappingURL=bootstrap.d.ts.map