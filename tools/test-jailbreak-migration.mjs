// 迁移逻辑自检：历史发布的默认（git 4381ec7 版 cloneDefaultItems 产物）vs 新模块指纹比对 + 各迁移分支
import { cloneDefaultItems as oldClone } from './old-jailbreak-ref.mjs';
import { cloneDefaultItems, migrateLegacyItems, getJailbreakItems, LEGACY_DEFAULT_ITEMS } from '../src/jailbreak.js';

const fp = (items) => JSON.stringify(items);
const oldSaved = oldClone();
let failed = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

check('历史默认指纹 === LEGACY_DEFAULT_ITEMS 指纹', fp(oldSaved) === fp(LEGACY_DEFAULT_ITEMS));

const r1 = migrateLegacyItems(oldSaved);
check('原样保存旧默认 → 迁移为新默认(4条/首条user)', r1.migrated && r1.items.length === 4 && r1.items[0].id === 'default_identity' && r1.items[0].role === 'user');

const engineMsgs = getJailbreakItems({ jailbreak: { items: oldSaved } });
check('引擎读取路径：存旧默认 → 返回新默认', engineMsgs.length === 4 && engineMsgs[0].role === 'user');

const custom = JSON.parse(JSON.stringify(oldSaved));
custom[0].content += '（微调）';
const r2 = migrateLegacyItems(custom);
check('改过一个字 → 不迁移', !r2.migrated && r2.items[0].content.includes('（微调）'));

const disabled = JSON.parse(JSON.stringify(oldSaved));
disabled[1].enabled = false;
check('改过开关 → 不迁移', !migrateLegacyItems(disabled).migrated);

const extra = [...oldSaved, { id: 'x', enabled: true, position: 'tail', role: 'user', content: 'x' }];
check('加过条目 → 不迁移', !migrateLegacyItems(extra).migrated);

check('无配置 → 新默认(4条)', getJailbreakItems({}).length === 4);
check('空items → 新默认(4条)', getJailbreakItems({ jailbreak: { items: [] } }).length === 4);

process.exit(failed ? 1 : 0);
