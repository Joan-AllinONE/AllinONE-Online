/* tools/test-word-import.js — 单词表文件解析测试
 * 运行： node tools/test-word-import.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const win = { window: {} };
win.window = win;
const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/word-parser.js'), 'utf8'), ctx, { filename: 'word-parser.js' });
const P = win.WordParser;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function show(r) { return JSON.stringify(r.words.slice(0, 2)); }

console.log('\n【A】常见分隔格式');
let r = P.parse('apple|/ˈæpl/|苹果|I eat an apple.\nbrave|/breɪv/|勇敢的|Be brave.');
ok('竖线分隔：数量', r.count === 2, r.count);
ok('竖线分隔：字段正确', r.words[0].w === 'apple' && r.words[0].p === '/ˈæpl/' && r.words[0].c === '苹果' && /I eat/.test(r.words[0].e), show(r));

r = P.parse('apple,/ˈæpl/,苹果,I eat an apple.\nbrave,/breɪv/,勇敢的,Be brave.');
ok('CSV 逗号分隔：数量', r.count === 2, r.count);
ok('CSV 逗号分隔：字段正确', r.words[0].c === '苹果' && r.words[0].p === '/ˈæpl/', show(r));

r = P.parse('apple,/ˈæpl/,苹果,"I eat an apple, every day."');
ok('CSV 引号内的逗号不被切断', r.words[0].e === 'I eat an apple, every day.', r.words[0].e);

r = P.parse('apple\t/ˈæpl/\t苹果\nbrave\t/breɪv/\t勇敢的');
ok('TSV 制表符分隔', r.count === 2 && r.words[0].c === '苹果', show(r));

r = P.parse('apple，苹果\nbrave，勇敢的');
ok('中文逗号分隔', r.count === 2 && r.words[0].c === '苹果', show(r));

console.log('\n【B】松散格式（没有统一分隔符）');
r = P.parse('apple: 苹果\nbrave: 勇敢的');
ok('冒号分隔', r.count === 2 && r.words[0].c === '苹果', show(r));
r = P.parse('apple = 苹果');
ok('等号分隔', r.words[0].c === '苹果', show(r));
r = P.parse('apple 苹果\nbrave 勇敢的');
ok('空格分隔', r.count === 2 && r.words[0].c === '苹果', show(r));
r = P.parse('apple /ˈæpl/ 苹果');
ok('空格分隔且带音标', r.words[0].c === '苹果' && r.words[0].p === '/ˈæpl/', show(r));
r = P.parse('apple\nbrave\ncoffee');
ok('纯单词列表', r.count === 3 && r.words[0].w === 'apple' && r.words[0].c === '', show(r));

console.log('\n【C】序号 / 注释 / 空行');
r = P.parse('1. apple 苹果\n2、brave 勇敢的\n- coffee 咖啡\n* dream 梦想');
ok('去掉行首序号与项目符号', r.count === 4 && r.words[0].w === 'apple' && r.words[3].w === 'dream', show(r));
r = P.parse('# 我的词库\napple 苹果\n\n// 下面继续\nbrave 勇敢的');
ok('跳过 # 与 // 注释行', r.count === 2, r.count);

console.log('\n【D】JSON');
r = P.parse('["apple","brave","coffee"]');
ok('JSON 字符串数组', r.count === 3 && r.words[0].w === 'apple', show(r));
r = P.parse('[{"word":"apple","phonetic":"/ˈæpl/","meaning":"苹果","example":"I eat an apple."}]');
ok('JSON 对象数组（英文字段名）', r.words[0].c === '苹果' && r.words[0].p === '/ˈæpl/', show(r));
r = P.parse('[{"单词":"apple","中文":"苹果"}]');
ok('JSON 中文字段名', r.words[0].w === 'apple' && r.words[0].c === '苹果', show(r));
r = P.parse('{"words":[{"en":"apple","cn":"苹果"},{"en":"brave","cn":"勇敢的"}]}');
ok('JSON 包装对象 {words:[]}', r.count === 2 && r.words[1].c === '勇敢的', show(r));

console.log('\n【E】列顺序打乱也能认');
r = P.parse('苹果|apple\n勇敢的|brave');
ok('中文在前、单词在后', r.count === 2 && r.words[0].w === 'apple' && r.words[0].c === '苹果', show(r));
r = P.parse('苹果|/ˈæpl/|apple');
ok('中文+音标+单词（乱序三列）', r.words[0].w === 'apple' && r.words[0].c === '苹果' && r.words[0].p === '/ˈæpl/', show(r));

console.log('\n【F】脏数据处理');
r = P.parse('apple 苹果\napple 苹果 again\nbrave 勇敢的');
ok('重复单词被合并', r.count === 2 && r.dup === 1, r.count + ' dup=' + r.dup);
r = P.parse('apple 苹果\n这是一句完全无关的说明文字\nbrave 勇敢的');
ok('看不懂的行被跳过并计数', r.count === 2 && r.skipped === 1, r.count + ' skipped=' + r.skipped);
r = P.parse('\uFEFFapple 苹果');
ok('UTF-8 BOM 不影响首行', r.words[0].w === 'apple', show(r));
r = P.parse('');
ok('空文件有友好提示', !r.ok && !!r.message, r.message);
r = P.parse('中文一行\n另一行中文');
ok('全是中文时报「没认出来」', !r.ok && /单词/.test(r.message), r.message);

console.log('\n【G】导出回写');
const txt = P.toText([{ w: 'apple', p: '/ˈæpl/', c: '苹果', e: 'I eat an apple.' }]);
ok('导出为竖线格式', txt === 'apple|/ˈæpl/|苹果|I eat an apple.', txt);
const round = P.parse(txt);
ok('导出后能被自己解析回来', round.count === 1 && round.words[0].c === '苹果');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
