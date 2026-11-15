/**
 * 键盘路径验收（D-A）：用 CDP `Input.dispatchKeyEvent` 打真实按键，**不用 .click() 冒充**。
 *
 * 为什么单独一个文件：键盘断言与「截图 + 标记 dump」是两种证据，混在一个函数里以后
 * 谁也不敢改。这里只接收一个已连上的 CDP 客户端，按 **RFC-0001 §7 交互规范** 逐步走：
 * Tab 进路径框 -> 键入路径 + Enter -> ArrowDown/ArrowUp 移动游标 -> Backspace 上一级 -> Escape 关闭。
 *
 * 三条纪律：
 * 1. 每一步都读 `document.activeElement`（经 window.__PREVIEW_FOCUS__），**没有读数不算通过**；
 * 2. 走不通就记 FAIL 并把焦点轨迹原样留下（最小复现 = 前面的按键序列 + 当时的焦点）；
 * 3. 前置步骤失败时后续步骤记「未验证」，不猜、不补、不改 src/**。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SEP = String.fromCharCode(92);

/** 场景 local 的夹具根（preview-fixtures 的 LOCAL_ROOT）下的工程目录。 */
export const PROJECT_PATH = ['C:', 'Users', 'hui', 'workspace', 'dsh-remote-cr'].join(SEP);
/** 上一级：场景 local 的父目录。 */
export const PARENT_PATH = ['C:', 'Users', 'hui', 'workspace'].join(SEP);

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** Chrome 需要的键码：key/code/windowsVirtualKeyCode 三件套缺一个，焦点移动就不发生。 */
const KEY_DEFS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};

export async function pressKey(cdp, name) {
  const def = KEY_DEFS[name];
  if (def === undefined) throw new Error('没有定义的键：' + name);
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    nativeVirtualKeyCode: def.windowsVirtualKeyCode,
  };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await delay(90);
}

/**
 * 逐字符键入。
 *
 * 用 `type: 'char'` 而不是手工拼 shift：反斜杠与冒号在 ABNT2 / 法语键盘上的物理键位不同，
 * char 事件是不经过键盘布局的那条路，夹具路径对任何布局都一样打得出来。
 */
export async function typeText(cdp, text) {
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char, key: char });
    await delay(20);
  }
  await delay(120);
}

/** Ctrl+A：先全选再打字。路径框是受控输入且预填当前目录，不全选就会把旧值拼在前面。 */
export async function selectAll(cdp) {
  const base = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown', commands: ['selectAll'] }, base));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await delay(60);
}

/**
 * 走完一遍键盘路径，返回逐步记录。
 *
 * 返回结构是报告的直接数据源：每一步都有 expected / actual / pass / 截图。
 */
export async function runKeyboardSuite({ cdp, outDir, sceneId, viewportTag }) {
  const steps = [];
  const startedAt = new Date().toISOString();

  const add = (fields) => {
    const record = {
      id: fields.id,
      op: fields.op,
      expected: fields.expected,
      actual: fields.actual,
      pass: fields.pass === true,
      note: fields.note === undefined ? null : fields.note,
      error: fields.error === undefined ? null : fields.error,
      detail: fields.detail === undefined ? null : fields.detail,
      screenshot: null,
    };
    steps.push(record);
    return record;
  };

  const image = async (record, slug) => {
    try {
      const file = 'keys-' + sceneId + viewportTag + '-' + slug + '.png';
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(outDir, file), Buffer.from(result.data, 'base64'));
      record.screenshot = '.preview/' + file;
    } catch (error) {
      record.screenshotError = String(error && error.message);
    }
  };

  const focus = () => cdp.evaluate('window.__PREVIEW_FOCUS__ ? window.__PREVIEW_FOCUS__() : null');
  const blocked = (id, op, reason) =>
    add({ id, op, expected: '(前置步骤失败，未执行)', actual: reason, pass: false, detail: { blocked: true } });

  const summary = (reason) => {
    const passed = steps.filter((step) => step.pass).length;
    const blockedCount = steps.filter((step) => step.pass !== true && step.detail !== null && step.detail.blocked === true).length;
    const failed = steps.length - passed - blockedCount;
    return { sceneId, viewportTag, startedAt, finishedAt: new Date().toISOString(), projectPath: PROJECT_PATH, parentPath: PARENT_PATH, reason: reason === undefined ? null : reason, steps, passed, failed, blocked: blockedCount };
  };

  const write = async (result) => {
    const file = 'keys-' + sceneId + viewportTag + '.json';
    await writeFile(join(outDir, file), JSON.stringify(result, null, 2) + '\n', 'utf8');
    return Object.assign(result, { jsonPath: '.preview/' + file });
  };

  // ── K1 Tab 进入路径框 ────────────────────────────────────────────────
  await cdp.evaluate('if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); true');
  const visited = [];
  let reachedTab = null;
  let lastFocus = await focus();
  for (let index = 1; index <= 24; index += 1) {
    await pressKey(cdp, 'Tab');
    const current = await focus();
    if (current === null) {
      visited.push({ tab: index, marker: '(no focus probe)' });
      break;
    }
    const marker = current.active === null ? '(body)' : String(current.active.marker);
    visited.push({ tab: index, marker, value: current.active === null ? null : current.active.value });
    lastFocus = current;
    if (current.active !== null && current.active.marker === 'browser-path') {
      reachedTab = index;
      break;
    }
  }
  const k1 = add({
    id: 'K1',
    op: '从 body 起 Tab 到 [data-teleport="browser-path"]',
    expected: '焦点落在路径输入框上',
    actual: reachedTab === null ? 'Tab 24 次仍未进入路径框' : '第 ' + String(reachedTab) + ' 次 Tab 进入路径框',
    pass: reachedTab !== null,
    detail: { visited, tabbable: lastFocus === null ? null : lastFocus.tabbable, tabbableCount: lastFocus === null ? null : lastFocus.tabbableCount, step: lastFocus === null ? null : lastFocus.wizardStep },
  });
  await image(k1, '01-tab-path');

  if (reachedTab === null) {
    blocked('K2', 'Ctrl+A 后键入路径', 'K1 未进入路径框，输入框拿不到键盘事件');
    blocked('K3', 'Enter 提交路径', 'K1 未进入路径框');
    blocked('K4', 'Tab 进入目录条目', 'K1 未进入路径框');
    blocked('K5', 'ArrowDown 移动游标', 'K1 未进入路径框');
    blocked('K6', 'ArrowUp 移动游标', 'K1 未进入路径框');
    blocked('K7', 'Backspace 上一级', 'K1 未进入路径框');
    blocked('K8', 'Escape 关闭向导', 'K1 未进入路径框');
    return write(summary('K1 失败：路径框无法通过 Tab 到达'));
  }

  // ── K1b 聚焦即全选（R1 D-N1：Q3 之前没有任何断言守，K2 自己 Ctrl+A 把它掩盖了）──
  await delay(60);
  const selection1 = await cdp.evaluate(
    '(() => { const el = document.querySelector("[data-teleport=\'browser-path\']"); if (el === null) return null; return { start: el.selectionStart, end: el.selectionEnd, length: String(el.value || "").length, focused: document.activeElement === el }; })()',
  );
  const fullSelect =
    selection1 !== null && selection1 !== undefined && selection1.length > 0 &&
    selection1.start === 0 && selection1.end === selection1.length;
  const k1b = add({
    id: 'K1b',
    op: '聚焦路径框后自动全选',
    expected: 'selectionStart=0 且 selectionEnd=value.length',
    actual: selection1 === null || selection1 === undefined
      ? '(读不到输入框)'
      : 'start=' + String(selection1.start) + ' end=' + String(selection1.end) + ' len=' + String(selection1.length) + ' focused=' + String(selection1.focused),
    pass: fullSelect,
    detail: selection1,
  });
  await image(k1b, '01b-tab-path-selected');

  // ── K2 输入路径 ─────────────────────────────────────────────────────
  const before2 = await focus();
  await selectAll(cdp);
  await typeText(cdp, PROJECT_PATH);
  const after2 = await focus();
  const typed = after2 === null ? null : after2.pathValue;
  const k2 = add({
    id: 'K2',
    op: 'Ctrl+A 后逐字符键入 ' + PROJECT_PATH,
    expected: '路径框值 = ' + PROJECT_PATH,
    actual: typed,
    pass: typed === PROJECT_PATH,
    // 只在「实测没有全选」时提示：原先这句是硬编码，无论实际选没选都会打，把 R1 骗过一次（R2-D15）。
    note: fullSelect === false ? '聚焦后没有全选（K1b 已失败），K2 只能自己 Ctrl+A' : null,
    detail: { activeMarker: after2 === null || after2.active === null ? null : after2.active.marker, beforeValue: before2 === null ? null : before2.pathValue },
  });
  await image(k2, '02-typed-path');

  // ── K3 Enter 提交 ───────────────────────────────────────────────────
  const requestsBefore = await cdp.evaluate('window.__PREVIEW__ ? window.__PREVIEW__.requests.length : 0');
  await pressKey(cdp, 'Enter');
  await delay(700);
  const after3 = await focus();
  const issued = await cdp.evaluate('window.__PREVIEW__ ? window.__PREVIEW__.requests.slice(' + String(requestsBefore) + ') : []');
  const listCalls = (issued === null ? [] : issued).filter((entry) => String(entry.path).startsWith('/teleport/api/list'));
  const decoded = listCalls.map((entry) => decodeURIComponent(String(entry.path)));
  const k3 = add({
    id: 'K3',
    op: 'Enter 提交路径',
    expected: 'listing-path = ' + PROJECT_PATH + '，且 /list 只发一次',
    actual: (after3 === null ? null : after3.listingPath) + ' · /list ' + String(decoded.length) + ' 次',
    pass: after3 !== null && after3.listingPath === PROJECT_PATH && decoded.length === 1,
    note: decoded.length > 1 ? 'Enter 触发了 ' + String(decoded.length) + ' 次列目录（重复请求）' : null,
    detail: { listCalls: decoded, activeAfter: after3 === null || after3.active === null ? null : after3.active.marker, cursor: after3 === null || after3.cursor === null ? null : after3.cursor.name },
  });
  await image(k3, '03-enter-listing');

  // ── K4 Tab 进入条目 ─────────────────────────────────────────────────
  const visited4 = [];
  let reachedEntry = null;
  for (let index = 1; index <= 24; index += 1) {
    await pressKey(cdp, 'Tab');
    const current = await focus();
    const marker = current === null || current.active === null ? '(body)' : String(current.active.marker);
    visited4.push({ tab: index, marker });
    if (current !== null && current.active !== null && current.active.marker === 'entry') {
      reachedEntry = index;
      break;
    }
  }
  const k4 = add({
    id: 'K4',
    op: 'Tab 进入目录列表条目',
    expected: '焦点落在 [data-teleport="entry"] 上',
    actual: reachedEntry === null ? 'Tab 24 次未进入条目' : '第 ' + String(reachedEntry) + ' 次 Tab 进入条目',
    pass: reachedEntry !== null,
    detail: { visited: visited4 },
  });
  await image(k4, '04-tab-entry');

  if (reachedEntry === null) {
    blocked('K5', 'ArrowDown 移动游标', '焦点没进条目，ArrowDown 没有接收者');
    blocked('K6', 'ArrowUp 移动游标', '焦点没进条目');
    blocked('K7', 'Backspace 上一级', '焦点没进条目');
    blocked('K8', 'Escape 关闭向导', '焦点没进条目');
    return write(summary('K4 失败：条目无法通过 Tab 到达'));
  }

  // ── K5 ArrowDown ────────────────────────────────────────────────────
  const before5 = await focus();
  const before5Name = before5 === null || before5.cursor === null ? null : before5.cursor.name;
  await pressKey(cdp, 'ArrowDown');
  const after5 = await focus();
  const dirs = after5 === null || after5.directories === undefined ? [] : after5.directories;
  const name5 = after5 === null || after5.cursor === null ? null : after5.cursor.name;
  const expected5 = before5Name === null ? dirs[0] : dirs[(Math.max(dirs.indexOf(before5Name), 0) + 1) % Math.max(dirs.length, 1)];
  const k5 = add({
    id: 'K5',
    op: 'ArrowDown 移动游标',
    expected: 'data-active 条目变成 ' + String(expected5),
    actual: name5,
    pass: name5 !== null && name5 !== before5Name,
    note: name5 !== null && expected5 !== undefined && name5 !== expected5 ? '游标落点与目录顺序不一致（期望 ' + String(expected5) + '）' : null,
    detail: { before: before5Name, after: name5, directories: dirs, focusMarker: after5 === null || after5.active === null ? null : after5.active.marker },
  });
  await image(k5, '05-arrow-down');

  // ── K6 ArrowUp ──────────────────────────────────────────────────────
  await pressKey(cdp, 'ArrowUp');
  const after6 = await focus();
  const name6 = after6 === null || after6.cursor === null ? null : after6.cursor.name;
  const expected6 = before5Name !== null ? before5Name : dirs[dirs.length - 1];
  const k6 = add({
    id: 'K6',
    op: 'ArrowUp 移动游标',
    expected: 'data-active 回到 ' + String(expected6),
    actual: name6,
    pass: name6 !== null && name6 === expected6,
    detail: { before: name5, after: name6, focusMarker: after6 === null || after6.active === null ? null : after6.active.marker },
  });
  await image(k6, '06-arrow-up');

  // ── K7 Backspace 上一级 ─────────────────────────────────────────────
  const before7 = await focus();
  await pressKey(cdp, 'Backspace');
  await delay(600);
  const after7 = await focus();
  const k7 = add({
    id: 'K7',
    op: 'Backspace 上一级',
    expected: 'listing-path = ' + PARENT_PATH,
    actual: after7 === null ? null : after7.listingPath,
    pass: after7 !== null && after7.listingPath === PARENT_PATH,
    detail: { focusBefore: before7 === null || before7.active === null ? '(body)' : before7.active.marker, focusAfter: after7 === null || after7.active === null ? '(body)' : after7.active.marker },
  });
  await image(k7, '07-backspace-up');

  // ── K8 Enter 进入目录（RFC §7） ──────────────────────────────────────
  const before8 = await focus();
  const entryName = before8 !== null && before8.active !== null && before8.active.marker === 'entry' ? before8.active.text : null;
  const expected8 = entryName === null ? null : PARENT_PATH + SEP + entryName;
  const requests8 = await cdp.evaluate('window.__PREVIEW__ ? window.__PREVIEW__.requests.length : 0');
  await pressKey(cdp, 'Enter');
  await delay(700);
  const after8 = await focus();
  const issued8 = await cdp.evaluate('window.__PREVIEW__ ? window.__PREVIEW__.requests.slice(' + String(requests8) + ') : []');
  const list8 = (issued8 === null ? [] : issued8).filter((entry) => String(entry.path).startsWith('/teleport/api/list'));
  const k8 = add({
    id: 'K8',
    op: 'Enter 进入游标所在目录',
    expected: expected8 === null ? '焦点在条目上，进入 ' + PARENT_PATH + SEP + '<目录名>，/list 1 次' : 'listing-path = ' + expected8 + '，/list 1 次',
    actual: String(after8 === null ? null : after8.listingPath) + ' · /list ' + String(list8.length) + ' 次 · 焦点 ' + (before8 === null || before8.active === null ? '(body)' : before8.active.marker + ':' + before8.active.text),
    pass: expected8 !== null && after8 !== null && after8.listingPath === expected8 && list8.length === 1,
    note:
      list8.length > 1
        ? 'Enter 触发了 ' + String(list8.length) + ' 次列目录：按钮原生 click 与 entries 的 keydown 双触发'
        : entryName === null
          ? '焦点不在条目上（上一级之后焦点已经离开列表），Enter 没有接收者'
          : null,
    detail: { entryName, listCalls: list8.map((entry) => decodeURIComponent(String(entry.path))), focusAfter: after8 === null || after8.active === null ? null : after8.active.marker },
  });
  await image(k8, '08-enter-dir');

  // ── K9 Escape 关闭（当前焦点） ──────────────────────────────────────
  const before9 = await focus();
  const cancelBefore = before9 === null ? 0 : before9.onCancelCount;
  await pressKey(cdp, 'Escape');
  await delay(400);
  const after9 = await focus();
  const cancelAfter = after9 === null ? 0 : after9.onCancelCount;
  const k9 = add({
    id: 'K9',
    op: 'Escape 关闭向导',
    expected: 'onCancel 回调计数 +1',
    actual: '焦点 ' + (before9 === null || before9.active === null ? '(body)' : before9.active.marker) + ' · onCancel ' + String(cancelBefore) + ' -> ' + String(cancelAfter) + ' · wizard 仍挂载 = ' + String(after9 === null ? null : after9.wizardOpen),
    pass: cancelAfter === cancelBefore + 1,
    note: '预览页把 open 固定传 true，所以 onCancel 之后 DOM 不会消失；这里只断言回调，不冒充「面板已关闭」',
    detail: { focusBefore: before9 === null || before9.active === null ? '(body)' : before9.active.marker, wizardStep: after9 === null ? null : after9.wizardStep, actions: after9 === null ? null : after9.actions },
  });
  await image(k9, '09-escape');

  // ── K10 补救探针：把焦点 Tab 回向导内再 Escape ────────────────────────
  // 只回答一个问题：Escape 是「完全没实现」还是「只在焦点掉出向导时失效」。
  if (k9.pass !== true) {
    const visited10 = [];
    let inside = false;
    for (let index = 1; index <= 12; index += 1) {
      await pressKey(cdp, 'Tab');
      const current = await focus();
      visited10.push(current === null || current.active === null ? '(body)' : String(current.active.marker));
      if (current !== null && current.active !== null && current.active.owner === 'wizard') {
        inside = true;
        break;
      }
    }
    const before10 = await focus();
    const cancel10 = before10 === null ? 0 : before10.onCancelCount;
    await pressKey(cdp, 'Escape');
    await delay(400);
    const after10 = await focus();
    const cancel10After = after10 === null ? 0 : after10.onCancelCount;
    const k10 = add({
      id: 'K10',
      op: '焦点 Tab 回向导内后再 Escape（补救探针）',
      expected: 'onCancel 计数 +1（说明处理函数本身在，只是收不到事件）',
      actual: '焦点 ' + (before10 === null || before10.active === null ? '(body)' : before10.active.marker) + ' · onCancel ' + String(cancel10) + ' -> ' + String(cancel10After),
      pass: cancel10After === cancel10 + 1,
      note: inside ? 'Tab 把焦点送回向导内后 Escape 生效：绑定在向导根节点，焦点掉到 body 就收不到' : 'Tab 12 次也没能把焦点送回向导内',
      detail: { visited: visited10 },
    });
    await image(k10, '10-escape-refocused');
  }

  return write(summary());
}

export function printKeySuite(result) {
  const mark = (step) => (step.pass ? 'PASS ' : step.detail !== null && step.detail.blocked === true ? 'BLOCK' : 'FAIL ');
  process.stdout.write(
    'keys: 键盘路径 ' + result.sceneId + result.viewportTag + ' · 通过 ' + String(result.passed) +
      ' / 失败 ' + String(result.failed) + ' / 未验证 ' + String(result.blocked) + ' · ' + String(result.jsonPath) + '\n',
  );
  for (const step of result.steps) {
    process.stdout.write('   [' + mark(step) + '] ' + step.id + ' ' + step.op + ' -> ' + String(step.actual) + (step.screenshot === null ? '' : ' · ' + step.screenshot) + '\n');
    if (step.note !== null) process.stdout.write('        note: ' + step.note + '\n');
    if (step.error !== null) process.stdout.write('        error: ' + step.error + '\n');
  }
}
