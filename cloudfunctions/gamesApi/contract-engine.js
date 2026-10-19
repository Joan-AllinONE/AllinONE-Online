/* eslint-disable */
// ★ 自动生成文件（scripts/build-engine.cjs）—— 禁止手工编辑
// 源：src/contracts/index.ts（engine + templates）
// 重新生成：node scripts/build-engine.cjs

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/contracts/index.ts
var index_exports = {};
__export(index_exports, {
  ACR_SPEC_VERSION: () => ACR_SPEC_VERSION,
  ALL_STATES: () => ALL_STATES,
  CONTRACTS_ENABLED: () => CONTRACTS_ENABLED,
  CONTRACT_AUTO_EXECUTE: () => CONTRACT_AUTO_EXECUTE,
  CONTRACT_SHADOW_COMPARE: () => CONTRACT_SHADOW_COMPARE,
  GENESIS_HASH: () => GENESIS_HASH,
  GROUP_BUY: () => GROUP_BUY,
  GSO: () => GSO,
  LOW_RISK_EFFECTS: () => LOW_RISK_EFFECTS,
  PLATFORM_RULE_DEFAULTS: () => PLATFORM_RULE_DEFAULTS,
  RESERVED_TEMPLATE_KEYS: () => RESERVED_TEMPLATE_KEYS,
  STATE_TRANSITIONS: () => STATE_TRANSITIONS,
  TEAM_QUEST: () => TEAM_QUEST,
  UGC_KEY_RE: () => UGC_KEY_RE,
  UGC_MAX_CLAUSES: () => UGC_MAX_CLAUSES,
  UGC_MAX_EFFECTS_PER_CLAUSE: () => UGC_MAX_EFFECTS_PER_CLAUSE,
  UGC_MAX_FIELD_DEPTH: () => UGC_MAX_FIELD_DEPTH,
  UGC_MAX_SERIALIZED_BYTES: () => UGC_MAX_SERIALIZED_BYTES,
  appendEvent: () => appendEvent,
  applyUpdates: () => applyUpdates,
  canonicalize: () => canonicalize,
  classifyTemplateRisk: () => classifyTemplateRisk,
  computeCodeHash: () => computeCodeHash,
  computeEventHash: () => computeEventHash,
  deriveInitialStateData: () => deriveInitialStateData,
  evalNumber: () => evalNumber,
  evalString: () => evalString,
  evaluateExpression: () => evaluateExpression,
  executeTrigger: () => executeTrigger,
  getTemplate: () => getTemplate,
  isContractState: () => isContractState,
  isValidTransition: () => isValidTransition,
  lintExpression: () => lintExpression,
  lintUgcTemplate: () => lintUgcTemplate,
  listTemplates: () => listTemplates,
  merkleRoot: () => merkleRoot,
  registerTemplate: () => registerTemplate,
  sha256hex: () => sha256hex,
  triggerMatches: () => triggerMatches,
  validateClauses: () => validateClauses,
  validateEffectSpec: () => validateEffectSpec,
  validateParams: () => validateParams,
  validateTemplate: () => validateTemplate,
  validateUgcTemplate: () => validateUgcTemplate,
  verifyChain: () => verifyChain,
  verifyCodeHash: () => verifyCodeHash
});
module.exports = __toCommonJS(index_exports);

// src/contracts/types.ts
var PLATFORM_RULE_DEFAULTS = [
  // ---- 市场 ----
  { ruleKey: "market.commission_rate", value: 0.05, description: "\u5E02\u573A\u6210\u4EA4\u4F63\u91D1\u7387\uFF08__market/buy \u6536\u76CA\u53F0\u8D26\u8BB0\u8D26\u4F7F\u7528\uFF1B\u539F\u524D\u7AEF/\u670D\u52A1\u7AEF\u53CC\u5904\u786C\u7F16\u7801\u6536\u655B\uFF09" },
  // ---- 频控 / 限额 ----
  { ruleKey: "item_harvest.daily_limit", value: 10, description: "\u6E38\u620F\u9053\u5177\u6BCF\u65E5\u63D0\u53D6\u6B21\u6570\u4E0A\u9650\uFF08\u63A5\u5165\u70B9\uFF1AitemHarvestService / __item/harvest-limit\uFF09" },
  { ruleKey: "cross_exchange.daily_limit", value: 20, description: "\u8DE8\u6E38\u620F\u5151\u6362\u6BCF\u65E5\u6B21\u6570\u4E0A\u9650\uFF08\u63A5\u5165\u70B9\uFF1AcrossGameExchange\uFF09" },
  // ---- 开发者结算（原 gameDeveloperService DEFAULT_REVENUE_SHARE/DAY_MS 硬编码收敛） ----
  { ruleKey: "settlement.revenue_share_percent", value: 10, description: "\u6E38\u620F\u65B9\u9053\u5177/\u51ED\u8BC1\u9500\u552E\u7684\u5E73\u53F0\u62BD\u6210\u9ED8\u8BA4\u503C %\uFF08\u63A5\u5165\u70B9\uFF1AgameDeveloperService / PublishingPipeline\uFF09" },
  { ruleKey: "settlement.cycle_ms", value: 864e5, description: "\u5F00\u53D1\u8005\u6536\u76CA\u6BCF\u65E5\u7ED3\u7B97\u5468\u671F\u6BEB\u79D2\uFF08\u63A5\u5165\u70B9\uFF1AgameDeveloperService.executeDailySettlement\uFF09" },
  // ---- 治理计票（原 ProposalSkill 硬编码收敛） ----
  { ruleKey: "governance.pass_threshold", value: 0.5, description: "\u63D0\u6848\u901A\u8FC7\u9608\u503C\uFF1A\u8D5E\u6210\u6743\u91CD / \u603B\u6743\u91CD \u5FC5\u987B > \u8BE5\u503C\uFF08\u63A5\u5165\u70B9\uFF1AProposalSkill.finalizeProposal\uFF09" },
  { ruleKey: "governance.weight_acoin", value: 0.3, description: "\u6295\u7968\u6743\u91CD\u516C\u5F0F A \u5E01\u7CFB\u6570\uFF08\u63A5\u5165\u70B9\uFF1AProposalSkill.calculateVoteWeight\uFF09" },
  { ruleKey: "governance.weight_gamecoin", value: 0.1, description: "\u6295\u7968\u6743\u91CD\u516C\u5F0F\u6E38\u620F\u5E01\u7CFB\u6570\uFF08\u63A5\u5165\u70B9\uFF1AProposalSkill.calculateVoteWeight\uFF09" },
  { ruleKey: "governance.weight_cap", value: 1e3, description: "\u5355\u7528\u6237\u6295\u7968\u6743\u91CD\u4E0A\u9650\uFF08\u63A5\u5165\u70B9\uFF1AProposalSkill.calculateVoteWeight\uFF09" },
  { ruleKey: "governance.rule_cooldown_ms", value: 2592e5, description: "\u89C4\u5219\u4FEE\u6539\u516C\u793A\u671F\u6BEB\u79D2\uFF0C\u9ED8\u8BA4 72h\uFF08\u63A5\u5165\u70B9\uFF1A\u6CE8\u518C\u4E2D\u5FC3 seed / propose\uFF09" },
  // ---- 凭证平台级费率（原 voucher-system/templates.ts 硬编码收敛；模板只引用，汇率表留模板） ----
  { ruleKey: "voucher.recycle_daily_pct", value: 0.5, description: "\u6BCF\u65E5\u7ED3\u7B97\u56DE\u6536\u6BD4\u4F8B %\uFF08\u2192\u91D1\u5E93\uFF1B\u63A5\u5165\u70B9\uFF1A\u51ED\u8BC1\u6A21\u677F recycle-daily-settlement\uFF09" },
  { ruleKey: "voucher.exchange_fee_pct", value: 2, description: "\u51ED\u8BC1\u5151\u6362\u624B\u7EED\u8D39 %\uFF08\u2192\u9500\u6BC1\uFF1B\u63A5\u5165\u70B9\uFF1A\u51ED\u8BC1\u6A21\u677F recycle-exchange-fee\uFF09" },
  { ruleKey: "voucher.transfer_fee_pct", value: 0.5, description: "\u51ED\u8BC1\u8F6C\u8D26\u624B\u7EED\u8D39 %\uFF08\u2192\u5E73\u53F0\uFF1B\u63A5\u5165\u70B9\uFF1A\u51ED\u8BC1\u6A21\u677F recycle-transaction-fee\uFF09" },
  // ---- 跨游戏兑换（原 crossGameExchange.ts 硬编码收敛） ----
  { ruleKey: "cross_exchange.fee_rate", value: 0.1, description: "\u8DE8\u6E38\u620F\u5151\u6362\u624B\u7EED\u8D39\u7387\uFF08\u6309\u76EE\u6807\u9053\u5177\u4EF7\u503C\uFF1B\u63A5\u5165\u70B9\uFF1AcalcExchangeFee\uFF09" }
];

// src/contracts/config.ts
var CONTRACTS_ENABLED = true;
var ENV = typeof process !== "undefined" && process.env ? process.env : {};
var RAW = ENV.CONTRACT_AUTO_EXECUTE || "";
var DEV_DEFAULT = ENV.USE_MEMORY_DB === "true" ? "group-buy,team-quest,gso" : "";
var LIST = (RAW || DEV_DEFAULT).split(",").map((s) => s.trim()).filter(Boolean);
var CONTRACT_AUTO_EXECUTE = {
  "group-buy": LIST.includes("group-buy"),
  "team-quest": LIST.includes("team-quest"),
  gso: LIST.includes("gso")
};
var CONTRACT_SHADOW_COMPARE = true;

// src/contracts/engine/hash.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var H0 = new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
function utf8Bytes(input) {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c >= 55296 && c <= 56319 && i + 1 < input.length) {
      const lo = input.charCodeAt(i + 1);
      if (lo >= 56320 && lo <= 57343) {
        c = 65536 + (c - 55296 << 10) + (lo - 56320);
        i++;
      }
    }
    if (c < 128) {
      out.push(c);
    } else if (c < 2048) {
      out.push(192 | c >> 6, 128 | c & 63);
    } else if (c < 65536) {
      out.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
    } else {
      out.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
    }
  }
  return Uint8Array.from(out);
}
function sha256hex(input) {
  const msg = typeof input === "string" ? utf8Bytes(input) : input;
  const bitLenLo = msg.length * 8 >>> 0;
  const bitLenHi = Math.floor(msg.length * 8 / 4294967296);
  const totalLen = (msg.length + 8 >> 6) + 1 << 6;
  const padded = new Uint8Array(totalLen);
  padded.set(msg);
  padded[msg.length] = 128;
  const dv = new DataView(padded.buffer);
  dv.setUint32(totalLen - 8, bitLenHi, false);
  dv.setUint32(totalLen - 4, bitLenLo, false);
  const w = new Uint32Array(64);
  const h = Uint32Array.from(H0);
  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
      const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const ch = e & f ^ ~e & g;
      const t1 = hh + S1 + ch + K[i] + w[i] >>> 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const mj = a & b ^ a & c ^ b & c;
      const t2 = S0 + mj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += h[i].toString(16).padStart(8, "0");
  }
  return hex;
}

// src/contracts/engine/canonical.ts
function canonicalize(value) {
  return serialize(value, /* @__PURE__ */ new Set(), "$");
}
function serialize(v, seen, path) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v)) {
      throw new TypeError(`canonicalize: \u975E\u6709\u9650\u6570\u5B57 @ ${path}`);
    }
    return JSON.stringify(v);
  }
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new TypeError("canonicalize: \u68C0\u6D4B\u5230\u5FAA\u73AF\u5F15\u7528");
    seen.add(v);
    const s = "[" + v.map((x, i) => serialize(x, seen, `${path}[${i}]`)).join(",") + "]";
    seen.delete(v);
    return s;
  }
  if (t === "object") {
    if (seen.has(v)) throw new TypeError("canonicalize: \u68C0\u6D4B\u5230\u5FAA\u73AF\u5F15\u7528");
    seen.add(v);
    const obj = v;
    const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
    const s = "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k], seen, `${path}.${k}`)).join(",") + "}";
    seen.delete(v);
    return s;
  }
  throw new TypeError(`canonicalize: \u4E0D\u652F\u6301\u7684\u7C7B\u578B ${t} @ ${path}`);
}
function computeCodeHash(input) {
  return sha256hex(canonicalize(input));
}
function verifyCodeHash(templateKey, templateVersion, clauses, params, expected) {
  const recomputed = computeCodeHash({ templateKey, templateVersion, clauses, params });
  return { intact: recomputed === expected, recomputed };
}

// src/contracts/engine/evaluate.ts
var TWO_CHAR_OPS = ["==", "!=", "<=", ">=", "&&", "||"];
var ONE_CHAR_OPS = ["+", "-", "*", "/", "%", "<", ">", "!", "(", ")", ",", "?", ":", "[", "]", "."];
function isIdentStart(c) {
  return /[a-zA-Z_$]/.test(c);
}
function isIdentPart(c) {
  return /[a-zA-Z0-9_$]/.test(c);
}
function isDigit(c) {
  return c >= "0" && c <= "9";
}
function tokenize(src, maxTokens) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (toks.length >= maxTokens) {
      throw new SyntaxError(`\u8868\u8FBE\u5F0F\u8FC7\u957F\uFF08token \u8D85\u8FC7 ${maxTokens}\uFF09`);
    }
    if (isDigit(c)) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === "." && isDigit(src[j + 1])) {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) {
        throw new SyntaxError(`\u6570\u5B57\u5B57\u9762\u91CF\u6EA2\u51FA\uFF08\u975E\u6709\u9650\uFF09\uFF1A${src.slice(i, j).slice(0, 24)}\u2026`);
      }
      toks.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\") {
          const nxt = src[j + 1];
          if (nxt === void 0) throw new SyntaxError("\u5B57\u7B26\u4E32\u5B57\u9762\u91CF\u672A\u95ED\u5408");
          if (nxt === "n") s += "\n";
          else if (nxt === "t") s += "	";
          else if (nxt === "r") s += "\r";
          else s += nxt;
          j += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        s += ch;
        j++;
      }
      if (!closed) throw new SyntaxError("\u5B57\u7B26\u4E32\u5B57\u9762\u91CF\u672A\u95ED\u5408");
      toks.push({ t: "str", v: s });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new SyntaxError(`\u975E\u6CD5\u5B57\u7B26 "${c}"\uFF08\u4F4D\u7F6E ${i}\uFF09`);
  }
  return toks;
}
var BANNED_PROPS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var Parser = class {
  constructor(toks, maxDepth) {
    this.toks = toks;
    this.maxDepth = maxDepth;
  }
  pos = 0;
  depth = 0;
  peek() {
    return this.toks[this.pos];
  }
  eat() {
    const t = this.toks[this.pos];
    if (!t) throw new SyntaxError("\u8868\u8FBE\u5F0F\u610F\u5916\u7ED3\u675F");
    this.pos++;
    return t;
  }
  eatOp(v) {
    const t = this.peek();
    if (!t || t.t !== "op" || t.v !== v) {
      throw new SyntaxError(`\u671F\u671B "${v}"${t ? `\uFF0C\u5B9E\u9645 "${t.t === "op" || t.t === "id" ? t.v : String(t.v)}"` : ""}`);
    }
    this.pos++;
  }
  isOp(v) {
    const t = this.peek();
    return !!t && t.t === "op" && t.v === v;
  }
  parse() {
    const n = this.parseConditional();
    if (this.pos < this.toks.length) {
      throw new SyntaxError("\u8868\u8FBE\u5F0F\u5B58\u5728\u591A\u4F59\u5185\u5BB9");
    }
    return n;
  }
  enter() {
    this.depth++;
    if (this.depth > this.maxDepth) {
      throw new SyntaxError(`\u8868\u8FBE\u5F0F\u5D4C\u5957\u8FC7\u6DF1\uFF08\u8D85\u8FC7 ${this.maxDepth}\uFF09`);
    }
  }
  leave() {
    this.depth--;
  }
  parseConditional() {
    this.enter();
    try {
      const cond = this.parseOr();
      if (this.isOp("?")) {
        this.pos++;
        const a = this.parseConditional();
        this.eatOp(":");
        const b = this.parseConditional();
        return { k: "cond", c: cond, a, b };
      }
      return cond;
    } finally {
      this.leave();
    }
  }
  parseOr() {
    let l = this.parseAnd();
    while (this.isOp("||")) {
      this.pos++;
      l = { k: "bin", op: "||", l, r: this.parseAnd() };
    }
    return l;
  }
  parseAnd() {
    let l = this.parseEquality();
    while (this.isOp("&&")) {
      this.pos++;
      l = { k: "bin", op: "&&", l, r: this.parseEquality() };
    }
    return l;
  }
  parseEquality() {
    let l = this.parseComparison();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = this.eat().v;
      l = { k: "bin", op, l, r: this.parseComparison() };
    }
    return l;
  }
  parseComparison() {
    let l = this.parseAdditive();
    while (this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
      const op = this.eat().v;
      l = { k: "bin", op, l, r: this.parseAdditive() };
    }
    return l;
  }
  parseAdditive() {
    let l = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.eat().v;
      l = { k: "bin", op, l, r: this.parseMultiplicative() };
    }
    return l;
  }
  parseMultiplicative() {
    let l = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.eat().v;
      l = { k: "bin", op, l, r: this.parseUnary() };
    }
    return l;
  }
  parseUnary() {
    this.enter();
    try {
      if (this.isOp("!")) {
        this.pos++;
        return { k: "un", op: "!", arg: this.parseUnary() };
      }
      if (this.isOp("-")) {
        this.pos++;
        return { k: "un", op: "-", arg: this.parseUnary() };
      }
      return this.parsePrimary();
    } finally {
      this.leave();
    }
  }
  parsePrimary() {
    const t = this.peek();
    if (!t) throw new SyntaxError("\u8868\u8FBE\u5F0F\u610F\u5916\u7ED3\u675F");
    if (t.t === "num") {
      this.pos++;
      return { k: "num", v: t.v };
    }
    if (t.t === "str") {
      this.pos++;
      return { k: "str", v: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      this.pos++;
      this.enter();
      try {
        const inner = this.parseConditional();
        this.eatOp(")");
        return inner;
      } finally {
        this.leave();
      }
    }
    if (t.t === "op" && t.v === "[") {
      this.pos++;
      const items = [];
      if (!this.isOp("]")) {
        items.push(this.parseConditional());
        while (this.isOp(",")) {
          this.pos++;
          items.push(this.parseConditional());
        }
      }
      this.eatOp("]");
      return { k: "arr", items };
    }
    if (t.t === "id") {
      this.pos++;
      if (t.v === "true") return { k: "bool", v: true };
      if (t.v === "false") return { k: "bool", v: false };
      if (t.v === "null") return { k: "null" };
      if (this.isOp("(")) {
        this.pos++;
        const args = [];
        if (!this.isOp(")")) {
          args.push(this.parseConditional());
          while (this.isOp(",")) {
            this.pos++;
            args.push(this.parseConditional());
          }
        }
        this.eatOp(")");
        if (!BUILTINS.has(t.v)) {
          throw new SyntaxError(`\u672A\u77E5\u51FD\u6570 "${t.v}"\uFF08\u767D\u540D\u5355\uFF1A${[...BUILTINS.keys()].join(" ")}\uFF09`);
        }
        return { k: "call", name: t.v, args };
      }
      let node = { k: "var", name: t.v };
      for (; ; ) {
        if (this.isOp(".")) {
          this.pos++;
          const p = this.peek();
          if (!p || p.t !== "id") throw new SyntaxError('\u6210\u5458\u8BBF\u95EE "." \u540E\u5FC5\u987B\u662F\u6807\u8BC6\u7B26');
          if (BANNED_PROPS.has(p.v)) throw new SyntaxError(`\u7981\u6B62\u8BBF\u95EE\u5C5E\u6027 "${p.v}"`);
          this.pos++;
          if (this.isOp("(")) {
            throw new SyntaxError("\u7981\u6B62\u65B9\u6CD5\u8C03\u7528\uFF08\u4EC5\u767D\u540D\u5355\u9876\u5C42\u51FD\u6570\u53EF\u8C03\u7528\uFF09");
          }
          node = { k: "member", obj: node, prop: p.v };
          continue;
        }
        if (this.isOp("[")) {
          this.pos++;
          const idx = this.peek();
          if (!idx || idx.t !== "num" || !Number.isInteger(idx.v) || idx.v < 0) {
            throw new SyntaxError("\u6570\u7EC4\u7D22\u5F15\u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\uFF08\u4E0D\u652F\u6301\u52A8\u6001\u7D22\u5F15\uFF09");
          }
          this.pos++;
          this.eatOp("]");
          node = { k: "index", obj: node, idx: idx.v };
          continue;
        }
        break;
      }
      return node;
    }
    const unk = t;
    throw new SyntaxError(`\u610F\u5916\u7684\u8BB0\u53F7 "${unk.t === "op" || unk.t === "id" ? String(unk.v) : String(unk.v)}"`);
  }
};
function assertNumber(v, fn, argName) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`${fn}: \u53C2\u6570 ${argName} \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57`);
  }
  return v;
}
function deterministicRand(seed, i) {
  const h = sha256hex(`${seed}#${i}`);
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}
var BUILTINS = /* @__PURE__ */ new Map([
  [
    "min",
    (args) => {
      if (args.length === 0) throw new TypeError("min: \u81F3\u5C11\u4E00\u4E2A\u53C2\u6570");
      return Math.min(...args.map((a, i) => assertNumber(a, "min", `#${i}`)));
    }
  ],
  [
    "max",
    (args) => {
      if (args.length === 0) throw new TypeError("max: \u81F3\u5C11\u4E00\u4E2A\u53C2\u6570");
      return Math.max(...args.map((a, i) => assertNumber(a, "max", `#${i}`)));
    }
  ],
  ["floor", (args) => Math.floor(assertNumber(args[0], "floor", "x"))],
  ["ceil", (args) => Math.ceil(assertNumber(args[0], "ceil", "x"))],
  ["abs", (args) => Math.abs(assertNumber(args[0], "abs", "x"))],
  [
    "round",
    (args) => {
      const x = assertNumber(args[0], "round", "x");
      const d = args.length > 1 ? assertNumber(args[1], "round", "digits") : 0;
      if (!Number.isInteger(d) || d < 0 || d > 10) throw new TypeError("round: digits \u987B\u4E3A 0..10 \u6574\u6570");
      const m = 10 ** d;
      return Math.round(x * m) / m;
    }
  ],
  [
    "clamp",
    (args) => {
      const x = assertNumber(args[0], "clamp", "x");
      const lo = assertNumber(args[1], "clamp", "lo");
      const hi = assertNumber(args[2], "clamp", "hi");
      return Math.min(Math.max(x, lo), hi);
    }
  ],
  [
    "sum",
    (args) => {
      const arr = args[0];
      if (!Array.isArray(arr)) throw new TypeError("sum: \u53C2\u6570\u5FC5\u987B\u662F\u6570\u7EC4");
      let s = 0;
      arr.forEach((v, i) => {
        s += assertNumber(v, "sum", `[${i}]`);
      });
      return s;
    }
  ],
  [
    "size",
    (args) => {
      const v = args[0];
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return v.length;
      if (v !== null && typeof v === "object") return Object.keys(v).length;
      throw new TypeError("size: \u53C2\u6570\u5FC5\u987B\u662F\u6570\u7EC4/\u5B57\u7B26\u4E32/\u5BF9\u8C61");
    }
  ],
  [
    "rand",
    (args, seed) => {
      if (!seed) throw new TypeError("rand: \u6C42\u503C\u73AF\u5883\u7F3A\u5C11\u786E\u5B9A\u6027\u79CD\u5B50\uFF08seed\uFF09");
      const i = assertNumber(args[0], "rand", "i");
      if (!Number.isInteger(i) || i < 0 || i > 1e9) throw new TypeError("rand: i \u987B\u4E3A 0..1e9 \u6574\u6570");
      return deterministicRand(seed, i);
    }
  ],
  // ===== 合约域聚合函数（限购/份额校验用；只读数据访问）=====
  [
    "countUser",
    (args) => {
      const arr = args[0];
      const uid = args[1];
      if (!Array.isArray(arr)) throw new TypeError("countUser: \u7B2C 1 \u53C2\u5FC5\u987B\u662F\u6570\u7EC4\uFF08\u5982 state.contributions\uFF09");
      if (typeof uid !== "string") throw new TypeError("countUser: \u7B2C 2 \u53C2\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08userId\uFF09");
      return arr.filter((r) => r !== null && typeof r === "object" && r.userId === uid).length;
    }
  ],
  [
    "sumUser",
    (args) => {
      const arr = args[0];
      const uid = args[1];
      const field = args[2];
      if (!Array.isArray(arr)) throw new TypeError("sumUser: \u7B2C 1 \u53C2\u5FC5\u987B\u662F\u6570\u7EC4\uFF08\u5982 state.contributions\uFF09");
      if (typeof uid !== "string") throw new TypeError("sumUser: \u7B2C 2 \u53C2\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08userId\uFF09");
      if (typeof field !== "string") throw new TypeError('sumUser: \u7B2C 3 \u53C2\u5FC5\u987B\u662F\u5B57\u6BB5\u540D\u5B57\u7B26\u4E32\uFF08\u5982 "amount"\uFF09');
      let s = 0;
      for (const r of arr) {
        if (r === null || typeof r !== "object") continue;
        const rec = r;
        if (rec.userId !== uid) continue;
        s += assertNumber(rec[field], "sumUser", `${field}`);
      }
      return s;
    }
  ]
]);
var Evaluator = class {
  constructor(vars, seed, maxSteps) {
    this.vars = vars;
    this.seed = seed;
    this.maxSteps = maxSteps;
  }
  steps = 0;
  eval(node) {
    if (++this.steps > this.maxSteps) {
      throw new Error(`\u8868\u8FBE\u5F0F\u6C42\u503C\u6B65\u6570\u8D85\u9650\uFF08>${this.maxSteps}\uFF09`);
    }
    switch (node.k) {
      case "num":
      case "str":
      case "bool":
        return node.v;
      case "null":
        return null;
      case "arr":
        return node.items.map((it) => this.eval(it));
      case "var": {
        if (!Object.prototype.hasOwnProperty.call(this.vars, node.name)) {
          throw new ReferenceError(`\u672A\u77E5\u53D8\u91CF "${node.name}"\uFF08\u53EF\u7528\uFF1A${Object.keys(this.vars).join(" ")}\uFF09`);
        }
        const v = this.vars[node.name];
        if (typeof v === "function") {
          throw new TypeError(`\u53D8\u91CF "${node.name}" \u662F\u51FD\u6570\uFF0C\u7981\u6B62\u8BBF\u95EE`);
        }
        return v;
      }
      case "member": {
        const obj = this.eval(node.obj);
        return this.readProp(obj, node.prop);
      }
      case "index": {
        const obj = this.eval(node.obj);
        if (obj === null || obj === void 0) return null;
        if (!Array.isArray(obj)) throw new TypeError("\u6570\u7EC4\u7D22\u5F15\u8BBF\u95EE\u7684\u76EE\u6807\u4E0D\u662F\u6570\u7EC4");
        const v = obj[node.idx];
        return v === void 0 ? null : v;
      }
      case "call": {
        const args = node.args.map((a) => this.eval(a));
        const fn = BUILTINS.get(node.name);
        return fn(args, this.seed);
      }
      case "un": {
        if (node.op === "!") {
          return !this.truthy(this.eval(node.arg), "!");
        }
        const v = assertNumber(this.eval(node.arg), "-", "x");
        return -v;
      }
      case "bin":
        return this.evalBin(node);
      case "cond":
        return this.truthy(this.eval(node.c), "?:") ? this.eval(node.a) : this.eval(node.b);
    }
  }
  evalBin(node) {
    if (node.op === "&&") {
      return this.truthy(this.eval(node.l), "&&") ? this.eval(node.r) : false;
    }
    if (node.op === "||") {
      return this.truthy(this.eval(node.l), "||") ? true : this.eval(node.r);
    }
    const l = this.eval(node.l);
    const r = this.eval(node.r);
    switch (node.op) {
      case "+":
        if (typeof l === "string" || typeof r === "string") {
          if (l === null || r === null || typeof l === "object" || typeof r === "object" || typeof l === "boolean" || typeof r === "boolean") {
            throw new TypeError("+: \u5B57\u7B26\u4E32\u62FC\u63A5\u7684\u4E24\u4FA7\u5FC5\u987B\u662F string/number");
          }
          return String(l) + String(r);
        }
        this.assertArith(l, r, "+");
        return l + r;
      case "-":
        this.assertArith(l, r, "-");
        return l - r;
      case "*":
        this.assertArith(l, r, "*");
        return l * r;
      case "/":
        this.assertArith(l, r, "/");
        if (r === 0) throw new Error("/: \u9664\u6570\u4E3A 0\uFF08\u8D26\u672C\u8BED\u4E49\u7981\u6B62 NaN/Infinity\uFF09");
        return l / r;
      case "%":
        this.assertArith(l, r, "%");
        if (r === 0) throw new Error("%: \u6A21\u6570\u4E3A 0");
        return l % r;
      case "==":
        return this.strictEquals(l, r);
      case "!=":
        return !this.strictEquals(l, r);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (typeof l !== "number" || typeof r !== "number") {
          throw new TypeError(`${node.op}: \u4E24\u4FA7\u5FC5\u987B\u662F\u6570\u5B57\uFF08\u4E25\u683C\u8BED\u4E49\uFF0C\u65E0\u9690\u5F0F\u8F6C\u6362\uFF09`);
        }
        switch (node.op) {
          case "<":
            return l < r;
          case "<=":
            return l <= r;
          case ">":
            return l > r;
          default:
            return l >= r;
        }
      }
      default:
        throw new Error(`\u672A\u77E5\u8FD0\u7B97\u7B26 ${node.op}`);
    }
  }
  assertArith(l, r, op) {
    if (typeof l !== "number" || typeof r !== "number") {
      throw new TypeError(`${op}: \u7B97\u672F\u8FD0\u7B97\u4E24\u4FA7\u5FC5\u987B\u662F\u6570\u5B57\uFF08null/\u5E03\u5C14/\u6570\u7EC4/\u5BF9\u8C61\u4E0D\u53EF\u53C2\u4E0E\uFF09`);
    }
  }
  /** 严格相等：同类型比较；跨类型恒 false；对象按引用 */
  strictEquals(l, r) {
    if (l === null && r === null) return true;
    const tl = typeof l;
    const tr = typeof r;
    if (tl !== tr) return false;
    if (tl === "number" || tl === "string" || tl === "boolean") return l === r;
    return l === r;
  }
  truthy(v, op) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (v === null || v === void 0) return false;
    if (typeof v === "string") return v.length > 0;
    throw new TypeError(`${op}: \u6761\u4EF6\u4F4D\u7F6E\u4E0D\u63A5\u53D7 ${typeof v}`);
  }
  readProp(obj, prop) {
    if (obj === null || obj === void 0) return null;
    if (typeof obj !== "object" && typeof obj !== "string") {
      throw new TypeError(`\u4E0D\u80FD\u5BF9 ${typeof obj} \u53D6\u5C5E\u6027 "${prop}"`);
    }
    const v = obj[prop];
    if (typeof v === "function") throw new TypeError(`\u5C5E\u6027 "${prop}" \u662F\u51FD\u6570\uFF0C\u7981\u6B62\u8BBF\u95EE`);
    if (v === void 0) return null;
    return v;
  }
};
function evaluateExpression(expr, opts = {}) {
  const maxTokens = opts.maxTokens ?? 512;
  const maxDepth = opts.maxDepth ?? 64;
  const maxSteps = opts.maxSteps ?? 2048;
  const ast = new Parser(tokenize(expr, maxTokens), maxDepth).parse();
  return new Evaluator(opts.vars ?? {}, opts.seed, maxSteps).eval(ast);
}
function lintExpression(expr) {
  try {
    new Parser(tokenize(expr, 512), 64).parse();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function evalNumber(expr, opts = {}) {
  const v = evaluateExpression(expr, opts);
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`\u8868\u8FBE\u5F0F\u7ED3\u679C\u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57\uFF1A${expr}`);
  }
  return v;
}
function evalString(expr, opts = {}) {
  const v = evaluateExpression(expr, opts);
  if (typeof v !== "string") {
    throw new TypeError(`\u8868\u8FBE\u5F0F\u7ED3\u679C\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF1A${expr}`);
  }
  return v;
}

// src/contracts/engine/validate.ts
var STATE_TRANSITIONS = {
  draft: ["signing", "terminated"],
  // signing 可直达 active（TeamQuest 开团）/settling/refunded（GroupBuy/TeamQuest 族）
  signing: ["funded", "active", "settling", "refunded", "terminated"],
  funded: ["active", "settling", "refunded", "terminated"],
  active: ["settling", "disputed", "refunded", "breached", "terminated"],
  settling: ["fulfilled", "refunded", "disputed", "breached"],
  fulfilled: [],
  breached: ["terminated"],
  disputed: ["settling", "refunded", "terminated"],
  refunded: [],
  terminated: []
};
var ALL_STATES = [
  "draft",
  "signing",
  "funded",
  "active",
  "settling",
  "fulfilled",
  "breached",
  "disputed",
  "refunded",
  "terminated"
];
function isContractState(v) {
  return typeof v === "string" && ALL_STATES.includes(v);
}
function isValidTransition(from, to) {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
function checkField(rule, value, path, issues) {
  if (value === void 0 || value === null) {
    if (rule.required) issues.push({ path, message: "\u7F3A\u5C11\u5FC5\u586B\u5B57\u6BB5" });
    return;
  }
  switch (rule.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u6570\u5B57\uFF0C\u5B9E\u9645 ${typeof value}` });
        return;
      }
      if (rule.min !== void 0 && value < rule.min) issues.push({ path, message: `\u4E0D\u5F97\u5C0F\u4E8E ${rule.min}\uFF0C\u5B9E\u9645 ${value}` });
      if (rule.max !== void 0 && value > rule.max) issues.push({ path, message: `\u4E0D\u5F97\u5927\u4E8E ${rule.max}\uFF0C\u5B9E\u9645 ${value}` });
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF0C\u5B9E\u9645 ${typeof value}` });
        return;
      }
      if (rule.min !== void 0 && value.length < rule.min) issues.push({ path, message: `\u957F\u5EA6\u4E0D\u5F97\u5C0F\u4E8E ${rule.min}` });
      if (rule.max !== void 0 && value.length > rule.max) issues.push({ path, message: `\u957F\u5EA6\u4E0D\u5F97\u5927\u4E8E ${rule.max}` });
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") issues.push({ path, message: `\u5FC5\u987B\u662F\u5E03\u5C14\uFF0C\u5B9E\u9645 ${typeof value}` });
      return;
    }
    case "enum": {
      if (!rule.enumValues || rule.enumValues.length === 0) {
        issues.push({ path, message: "\u6A21\u677F\u5B9A\u4E49\u9519\u8BEF\uFF1Aenum \u89C4\u5219\u7F3A\u5C11 enumValues" });
        return;
      }
      if (!rule.enumValues.includes(value)) {
        issues.push({ path, message: `\u5FC5\u987B\u662F ${rule.enumValues.join(" / ")} \u4E4B\u4E00\uFF0C\u5B9E\u9645 ${JSON.stringify(value)}` });
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u6570\u7EC4\uFF0C\u5B9E\u9645 ${typeof value}` });
        return;
      }
      if (rule.minItems !== void 0 && value.length < rule.minItems) issues.push({ path, message: `\u5143\u7D20\u6570\u4E0D\u5F97\u5C0F\u4E8E ${rule.minItems}` });
      if (rule.maxItems !== void 0 && value.length > rule.maxItems) issues.push({ path, message: `\u5143\u7D20\u6570\u4E0D\u5F97\u5927\u4E8E ${rule.maxItems}` });
      if (rule.itemRule) {
        value.forEach((item, i) => checkField(rule.itemRule, item, `${path}[${i}]`, issues));
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u5BF9\u8C61\uFF0C\u5B9E\u9645 ${typeof value}` });
        return;
      }
      if (rule.fields) {
        const obj = value;
        for (const [k, sub] of Object.entries(rule.fields)) {
          checkField(sub, obj[k], `${path}.${k}`, issues);
        }
      }
      return;
    }
    default:
      issues.push({ path, message: `\u6A21\u677F\u5B9A\u4E49\u9519\u8BEF\uFF1A\u672A\u77E5\u89C4\u5219\u7C7B\u578B ${String(rule.type)}` });
  }
}
function validateParams(schema, params) {
  const issues = [];
  if (typeof params !== "object" || params === null) {
    return { ok: false, issues: [{ path: "params", message: "params \u5FC5\u987B\u662F\u5BF9\u8C61" }] };
  }
  for (const [key, rule] of Object.entries(schema)) {
    checkField(rule, params[key], `params.${key}`, issues);
  }
  for (const key of Object.keys(params)) {
    if (!(key in schema)) {
      issues.push({ path: `params.${key}`, message: "\u672A\u77E5\u5B57\u6BB5\uFF08\u53C2\u6570\u9762\u5C01\u95ED\uFF0C\u672A\u5728 paramsSchema \u4E2D\u58F0\u660E\uFF09" });
    }
  }
  return { ok: issues.length === 0, issues };
}
var EFFECT_TYPES = [
  "freezeVoucher",
  "unfreezeVoucher",
  "transferVoucher",
  "mintVoucher",
  "mintShareVouchers",
  "walletTransfer",
  "treasuryDeposit",
  "splitPayout",
  "refundAll",
  "grantGovernanceWeight",
  "penalize",
  "setState",
  "openDispute",
  "notify"
];
var REQUIRED_FIELDS = {
  freezeVoucher: ["voucherId", "reason"],
  unfreezeVoucher: ["voucherId", "reason"],
  transferVoucher: ["voucherId", "toUserId", "reason"],
  mintVoucher: ["toUserId", "voucher", "reason"],
  mintShareVouchers: ["currency", "table", "lockupMs", "reason"],
  walletTransfer: ["toUserId", "currency", "amount", "reason"],
  treasuryDeposit: ["currency", "amount", "reason"],
  splitPayout: ["currency", "table", "reason"],
  refundAll: ["reason"],
  grantGovernanceWeight: ["gameId", "toUserId", "topic", "weightBps", "reason"],
  penalize: ["userId", "currency", "amount", "forfeitTo", "reason"],
  setState: ["to", "reason"],
  openDispute: ["byUserId", "reason"],
  notify: ["message"]
};
var CURRENCIES = ["gameCoins", "aCoins"];
var FORFEIT_TARGETS = ["rewardPool", "treasury", "members"];
function checkVal(v, kind, path, issues) {
  if (typeof v === "string" && v.startsWith("expr:")) {
    const lint = lintExpression(v.slice(5).trim());
    if (!lint.ok) issues.push({ path, message: `\u8868\u8FBE\u5F0F\u8BED\u6CD5\u9519\u8BEF\uFF1A${lint.error}` });
    return;
  }
  switch (kind) {
    case "num":
      if (typeof v !== "number" || !Number.isFinite(v)) {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u6570\u5B57\u6216 'expr:' \u8868\u8FBE\u5F0F\uFF0C\u5B9E\u9645 ${JSON.stringify(v)}` });
      }
      break;
    case "str":
      if (typeof v !== "string") {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216 'expr:' \u8868\u8FBE\u5F0F\uFF0C\u5B9E\u9645 ${typeof v}` });
      }
      break;
    case "state":
      if (!isContractState(v)) {
        issues.push({ path, message: `\u5FC5\u987B\u662F\u5408\u6CD5\u5408\u7EA6\u72B6\u6001\uFF0C\u5B9E\u9645 ${JSON.stringify(v)}` });
      }
      break;
  }
}
function validateEffectSpec(spec, whitelist, path, issues) {
  if (!EFFECT_TYPES.includes(spec.type)) {
    issues.push({ path, message: `\u672A\u77E5 EffectType "${String(spec.type)}"` });
    return;
  }
  if (!whitelist.includes(spec.type)) {
    issues.push({ path, message: `Effect "${spec.type}" \u4E0D\u5728\u6A21\u677F\u767D\u540D\u5355\u5185\uFF08\u767D\u540D\u5355\uFF1A${whitelist.join(" ")}\uFF09` });
    return;
  }
  for (const f of REQUIRED_FIELDS[spec.type]) {
    if (spec[f] === void 0) {
      issues.push({ path, message: `\u7F3A\u5C11\u5FC5\u586B\u5B57\u6BB5 "${f}"` });
    }
  }
  if (spec.amount !== void 0) {
    checkVal(spec.amount, "num", `${path}.amount`, issues);
    if (typeof spec.amount === "number" && spec.amount < 0) {
      issues.push({ path, message: "amount \u4E0D\u5F97\u4E3A\u8D1F" });
    }
  }
  if (spec.bps !== void 0 || spec.weightBps !== void 0) {
    const bps = spec.bps ?? spec.weightBps;
    checkVal(bps, "num", `${path}.bps`, issues);
    if (typeof bps === "number" && (bps < 0 || bps > 1e4)) {
      issues.push({ path, message: "bps \u5FC5\u987B\u5728 0..10000" });
    }
  }
  if (spec.to !== void 0) checkVal(spec.to, "state", `${path}.to`, issues);
  if (spec.purpose !== void 0) checkVal(spec.purpose, "str", `${path}.purpose`, issues);
  if (spec.currency !== void 0 && !spec.currency.startsWith("expr:") && !CURRENCIES.includes(spec.currency)) {
    issues.push({ path, message: `currency \u5FC5\u987B\u662F ${CURRENCIES.join(" / ")} \u6216 'expr:' \u8868\u8FBE\u5F0F` });
  }
  if (spec.forfeitTo !== void 0 && !FORFEIT_TARGETS.includes(spec.forfeitTo)) {
    issues.push({ path, message: `forfeitTo \u5FC5\u987B\u662F ${FORFEIT_TARGETS.join(" / ")}` });
  }
  if (spec.voucher !== void 0) {
    if (!spec.voucher.schemaName || !spec.voucher.title) {
      issues.push({ path, message: "mintVoucher.voucher \u7F3A\u5C11 schemaName/title" });
    }
    if (spec.voucher.denomination !== void 0) {
      checkVal(spec.voucher.denomination, "num", `${path}.voucher.denomination`, issues);
    }
  }
  if (spec.table !== void 0) {
    const t = spec.table;
    if (t.kind === "literal") {
      if (!Array.isArray(t.rows)) {
        issues.push({ path, message: "table.literal.rows \u5FC5\u987B\u662F\u6570\u7EC4" });
      } else {
        t.rows.forEach((r, i) => {
          if (!r.userId || typeof r.amount !== "number" || r.amount <= 0) {
            issues.push({ path, message: `table.rows[${i}] \u9700\u8981 userId \u4E0E\u6B63\u6570 amount` });
          }
        });
      }
    } else if (t.kind === "byField") {
      if (!t.stateField || !t.amountField) {
        issues.push({ path, message: "table.byField \u9700\u8981 stateField \u4E0E amountField" });
      }
      if (t.mode === "share" && t.poolAmount === void 0) {
        issues.push({ path, message: "table.byField share \u6A21\u5F0F\u5FC5\u987B\u58F0\u660E poolAmount" });
      }
      if (t.poolAmount !== void 0) checkVal(t.poolAmount, "num", `${path}.table.poolAmount`, issues);
    } else {
      issues.push({ path, message: `\u672A\u77E5 table.kind "${String(t.kind)}"` });
    }
  }
}
var FIELD_PATH_RE = /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/;
function validateClauses(clauses, whitelist) {
  const issues = [];
  clauses.forEach((clause, ci) => {
    const cPath = `clauses[${ci}](${clause.id || "?"})`;
    if (!clause.id) issues.push({ path: cPath, message: "\u7F3A\u5C11\u6761\u6B3E id" });
    if (!clause.title) issues.push({ path: cPath, message: "\u7F3A\u5C11\u6761\u6B3E title" });
    const on = clause.on;
    if (!on || !on.id) issues.push({ path: `${cPath}.on`, message: "\u7F3A\u5C11\u89E6\u53D1\u5668 id" });
    const kinds = ["event", "protocol", "cron", "manual"];
    if (!kinds.includes(on?.kind)) {
      issues.push({ path: `${cPath}.on`, message: `kind \u5FC5\u987B\u662F ${kinds.join(" / ")}` });
    } else {
      if (on.kind === "event" || on.kind === "protocol") {
        if (!on.match) issues.push({ path: `${cPath}.on`, message: `${on.kind} \u89E6\u53D1\u5668\u5FC5\u987B\u58F0\u660E match \u4E8B\u4EF6\u540D` });
      }
      if (on.kind === "manual" && !on.action) {
        issues.push({ path: `${cPath}.on`, message: "manual \u89E6\u53D1\u5668\u5FC5\u987B\u58F0\u660E action \u52A8\u4F5C\u540D" });
      }
      if (on.kind === "cron" && !on.schedule) {
        issues.push({ path: `${cPath}.on`, message: "cron \u89E6\u53D1\u5668\u5FC5\u987B\u58F0\u660E schedule \u8C03\u5EA6\u540D" });
      }
    }
    if (on?.enabledStates) {
      on.enabledStates.forEach((s, i) => {
        if (!isContractState(s)) issues.push({ path: `${cPath}.on.enabledStates[${i}]`, message: `\u975E\u6CD5\u72B6\u6001 "${String(s)}"` });
      });
    }
    if (clause.when !== void 0) {
      const lint = lintExpression(clause.when);
      if (!lint.ok) issues.push({ path: `${cPath}.when`, message: `\u8868\u8FBE\u5F0F\u8BED\u6CD5\u9519\u8BEF\uFF1A${lint.error}` });
    }
    if (!Array.isArray(clause.then) || clause.then.length === 0) {
      issues.push({ path: `${cPath}.then`, message: "\u6761\u6B3E\u5FC5\u987B\u58F0\u660E\u81F3\u5C11\u4E00\u4E2A Effect" });
    } else {
      clause.then.forEach((spec, ei) => {
        validateEffectSpec(spec, whitelist, `${cPath}.then[${ei}]`, issues);
      });
    }
    (clause.updates ?? []).forEach((u, ui) => {
      const uPath = `${cPath}.updates[${ui}]`;
      if (!FIELD_PATH_RE.test(u.field)) {
        issues.push({ path: uPath, message: `\u975E\u6CD5\u5B57\u6BB5\u8DEF\u5F84 "${u.field}"` });
      }
      if (u.op !== "add" && u.op !== "set" && u.op !== "push") {
        issues.push({ path: uPath, message: `op \u5FC5\u987B\u662F add/set/push\uFF0C\u5B9E\u9645 "${String(u.op)}"` });
      }
      if (u.op === "push") {
        if (!u.userIdExpr || !u.amountExpr) {
          issues.push({ path: uPath, message: "push \u9700\u8981\u58F0\u660E userIdExpr \u4E0E amountExpr" });
        } else {
          const l1 = lintExpression(u.userIdExpr);
          if (!l1.ok) issues.push({ path: uPath, message: `userIdExpr \u8BED\u6CD5\u9519\u8BEF\uFF1A${l1.error}` });
          const l2 = lintExpression(u.amountExpr);
          if (!l2.ok) issues.push({ path: uPath, message: `amountExpr \u8BED\u6CD5\u9519\u8BEF\uFF1A${l2.error}` });
        }
      } else {
        checkVal(u.value, "num", `${uPath}.value`, issues);
      }
    });
  });
  return issues;
}
function validateTemplate(tpl) {
  const issues = [];
  if (!tpl.key) issues.push({ path: "key", message: "\u7F3A\u5C11\u6A21\u677F key" });
  if (!Number.isInteger(tpl.version) || tpl.version < 1) {
    issues.push({ path: "version", message: "version \u5FC5\u987B\u662F \u22651 \u6574\u6570" });
  }
  if (tpl.family !== "community_revenue" && tpl.family !== "teamup") {
    issues.push({ path: "family", message: `family \u5FC5\u987B\u662F community_revenue / teamup` });
  }
  if (!Array.isArray(tpl.effectsWhitelist) || tpl.effectsWhitelist.length === 0) {
    issues.push({ path: "effectsWhitelist", message: "\u5FC5\u987B\u58F0\u660E\u975E\u7A7A Effect \u767D\u540D\u5355" });
  } else {
    tpl.effectsWhitelist.forEach((e, i) => {
      if (!EFFECT_TYPES.includes(e)) issues.push({ path: `effectsWhitelist[${i}]`, message: `\u672A\u77E5 EffectType "${String(e)}"` });
    });
  }
  if (!isContractState(tpl.initialState)) {
    issues.push({ path: "initialState", message: `\u975E\u6CD5\u521D\u59CB\u72B6\u6001 "${String(tpl.initialState)}"` });
  }
  if (!Array.isArray(tpl.clauses) || tpl.clauses.length === 0) {
    issues.push({ path: "clauses", message: "\u6A21\u677F\u5FC5\u987B\u58F0\u660E\u81F3\u5C11\u4E00\u6761\u6761\u6B3E" });
  }
  const clauseIssues = validateClauses(tpl.clauses ?? [], tpl.effectsWhitelist ?? []);
  issues.push(...clauseIssues);
  return { ok: issues.length === 0, issues };
}

// src/contracts/engine/execute.ts
var DEFAULT_ENABLED_STATES = ["funded", "active"];
function triggerMatches(on, ev) {
  if (on.kind !== ev.kind) return false;
  switch (on.kind) {
    case "event":
    case "protocol": {
      const m = on.match ?? "";
      if (m.endsWith(":*")) return ev.type.startsWith(m.slice(0, -1));
      return m === ev.type;
    }
    case "manual":
      return on.action === ev.type;
    case "cron":
      return on.schedule === ev.type;
    default:
      return false;
  }
}
function hasTriggerEvent(instance, triggerId) {
  return instance.history.some(
    (h) => h.type === "trigger" && h.payload.triggerId === triggerId
  );
}
function resolveNum(v, env, path, seed) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`${path}: \u975E\u6709\u9650\u6570\u5B57`);
    return v;
  }
  if (typeof v === "string" && v.startsWith("expr:")) {
    const n = evalNumber(v.slice(5).trim(), { vars: env, seed });
    if (!Number.isFinite(n)) throw new TypeError(`${path}: \u8868\u8FBE\u5F0F\u7ED3\u679C\u975E\u6709\u9650`);
    return n;
  }
  throw new TypeError(`${path}: \u5FC5\u987B\u662F\u6570\u5B57\u6216 'expr:' \u8868\u8FBE\u5F0F`);
}
function resolveStr(v, env, _path, seed) {
  if (v === void 0) return void 0;
  if (v.startsWith("expr:")) {
    return evalString(v.slice(5).trim(), { vars: env, seed });
  }
  return v;
}
function getPath(obj, field) {
  let cur = obj;
  for (const seg of field.split(".")) {
    if (cur === null || cur === void 0) return void 0;
    if (typeof cur !== "object") return void 0;
    cur = cur[seg];
  }
  return cur;
}
var VALID_CURRENCIES = ["gameCoins", "aCoins"];
var STATES_SET = /* @__PURE__ */ new Set([
  "draft",
  "signing",
  "funded",
  "active",
  "settling",
  "fulfilled",
  "breached",
  "disputed",
  "refunded",
  "terminated"
]);
function resolveCurrency(v, env, p, seed) {
  const s = resolveStr(v, env, p, seed);
  if (!s || !VALID_CURRENCIES.includes(s)) {
    throw new TypeError(`${p}: currency \u5FC5\u987B\u89E3\u6790\u4E3A gameCoins / aCoins\uFF0C\u5B9E\u9645 ${String(s)}`);
  }
  return s;
}
function resolveTable(table, stateData, env, seed) {
  if (!table) return [];
  if (table.kind === "literal") return table.rows.map((r) => ({ ...r }));
  const arr = getPath(stateData, table.stateField);
  if (!Array.isArray(arr)) {
    throw new TypeError(`splitPayout.byField: stateData.${table.stateField} \u4E0D\u662F\u6570\u7EC4`);
  }
  const userIdField = table.userIdField ?? "userId";
  const raw = [];
  for (const item of arr) {
    if (item === null || typeof item !== "object") continue;
    const rec = item;
    const userId = rec[userIdField];
    const amount = rec[table.amountField];
    if (typeof userId === "string" && userId && typeof amount === "number" && amount > 0) {
      raw.push({ userId, amount });
    }
  }
  if (table.mode !== "share") return raw;
  const pool = resolveNum(table.poolAmount ?? 0, env, "table.poolAmount", seed);
  if (pool < 0) throw new TypeError("table.poolAmount \u4E0D\u5F97\u4E3A\u8D1F");
  const totals = /* @__PURE__ */ new Map();
  let sum = 0;
  for (const r of raw) {
    totals.set(r.userId, (totals.get(r.userId) || 0) + r.amount);
    sum += r.amount;
  }
  if (sum <= 0) return [];
  const rows = [];
  let allocated = 0;
  const entries = [...totals.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  entries.forEach(([userId, w], i) => {
    if (i < entries.length - 1) {
      const amt = Math.floor(pool * w / sum);
      rows.push({ userId, amount: amt });
      allocated += amt;
    } else {
      rows.push({ userId, amount: Math.max(0, Math.floor(pool) - allocated) });
    }
  });
  return rows;
}
function resolveEffectSpec(spec, env, stateData, seed) {
  const p = `effect(${spec.type})`;
  const num = (v, field, opts) => {
    if (v === void 0) throw new TypeError(`${p}: \u7F3A\u5C11 ${field}`);
    const n = resolveNum(v, env, `${p}.${field}`, seed);
    if (opts?.nonNegative && n < 0) throw new TypeError(`${p}.${field} \u4E0D\u5F97\u4E3A\u8D1F`);
    return n;
  };
  const str = (v, field) => {
    if (v === void 0) throw new TypeError(`${p}: \u7F3A\u5C11 ${field}`);
    const s = resolveStr(v, env, p, seed);
    if (s === void 0) throw new TypeError(`${p}: \u7F3A\u5C11 ${field}`);
    return s;
  };
  switch (spec.type) {
    case "freezeVoucher":
      return { type: "freezeVoucher", voucherId: str(spec.voucherId, "voucherId"), reason: str(spec.reason, "reason") };
    case "unfreezeVoucher":
      return { type: "unfreezeVoucher", voucherId: str(spec.voucherId, "voucherId"), reason: str(spec.reason, "reason") };
    case "transferVoucher":
      return {
        type: "transferVoucher",
        voucherId: str(spec.voucherId, "voucherId"),
        fromUserId: resolveStr(spec.fromUserId, env, p, seed),
        toUserId: str(spec.toUserId, "toUserId"),
        reason: str(spec.reason, "reason")
      };
    case "mintVoucher": {
      if (!spec.voucher) throw new TypeError(`${p}: \u7F3A\u5C11 voucher`);
      const vs = spec.voucher;
      return {
        type: "mintVoucher",
        toUserId: str(spec.toUserId, "toUserId"),
        voucher: {
          schemaName: resolveStr(vs.schemaName, env, p, seed) ?? "",
          title: resolveStr(vs.title, env, p, seed) ?? "",
          denomination: vs.denomination !== void 0 ? num(vs.denomination, "voucher.denomination") : void 0,
          metadata: vs.metadata
        },
        reason: str(spec.reason, "reason")
      };
    }
    case "walletTransfer": {
      return {
        type: "walletTransfer",
        toUserId: str(spec.toUserId, "toUserId"),
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed),
        amount: num(spec.amount, "amount", { nonNegative: true }),
        fromUserId: resolveStr(spec.fromUserId, env, p, seed),
        purpose: resolveStr(spec.purpose, env, p, seed),
        reason: str(spec.reason, "reason")
      };
    }
    case "treasuryDeposit": {
      return {
        type: "treasuryDeposit",
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed),
        amount: num(spec.amount, "amount", { nonNegative: true }),
        reason: str(spec.reason, "reason")
      };
    }
    case "splitPayout": {
      const source = resolveStr(spec.source, env, p, seed);
      return {
        type: "splitPayout",
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed),
        table: resolveTable(spec.table, stateData, env, seed),
        purpose: resolveStr(spec.purpose, env, p, seed),
        source: source === "treasury" ? "treasury" : "escrow",
        reason: str(spec.reason, "reason")
      };
    }
    case "mintShareVouchers": {
      const rows = resolveTable(spec.table, stateData, env, seed);
      const total = rows.reduce((s, r) => s + r.amount, 0);
      if (total <= 0) throw new TypeError(`${p}: \u8BA4\u8D2D\u603B\u989D\u4E3A 0\uFF0C\u65E0\u6CD5\u94F8\u6536\u76CA\u5206\u6210\u51ED\u8BC1`);
      const lockupMs = num(spec.lockupMs ?? 0, "lockupMs", { nonNegative: true });
      return {
        type: "mintShareVouchers",
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed),
        rows: rows.map((r) => ({ userId: r.userId, amount: r.amount, share: r.amount / total })),
        lockupMs,
        reason: str(spec.reason, "reason")
      };
    }
    case "refundAll":
      return { type: "refundAll", purpose: resolveStr(spec.purpose, env, p, seed), reason: str(spec.reason, "reason") };
    case "grantGovernanceWeight": {
      const bps = spec.weightBps ?? spec.bps;
      return {
        type: "grantGovernanceWeight",
        gameId: str(spec.gameId, "gameId"),
        toUserId: str(spec.toUserId, "toUserId"),
        topic: str(spec.topic, "topic"),
        weightBps: num(bps, "weightBps"),
        reason: str(spec.reason, "reason")
      };
    }
    case "penalize": {
      if (!spec.forfeitTo) throw new TypeError(`${p}: \u7F3A\u5C11 forfeitTo`);
      return {
        type: "penalize",
        userId: str(spec.userId, "userId"),
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed),
        amount: num(spec.amount, "amount", { nonNegative: true }),
        forfeitTo: spec.forfeitTo,
        purpose: resolveStr(spec.purpose, env, p, seed),
        reason: str(spec.reason, "reason")
      };
    }
    case "setState": {
      const to = resolveStr(spec.to, env, p, seed);
      if (to === void 0) throw new TypeError(`${p}: \u7F3A\u5C11 to`);
      if (!STATES_SET.has(to)) throw new TypeError(`${p}: \u975E\u6CD5\u76EE\u6807\u72B6\u6001 "${to}"`);
      return { type: "setState", to, reason: str(spec.reason, "reason") };
    }
    case "openDispute":
      return { type: "openDispute", byUserId: str(spec.byUserId, "byUserId"), reason: str(spec.reason, "reason") };
    case "notify":
      return {
        type: "notify",
        message: resolveStr(spec.message, env, p, seed) ?? "",
        toUserIds: spec.toUserIds ? spec.toUserIds.map((u) => resolveStr(u, env, p, seed) ?? u) : void 0
      };
    default:
      throw new TypeError(`\u672A\u77E5 EffectType: ${String(spec.type)}`);
  }
}
function executeTrigger(instance, ev, opts) {
  if (hasTriggerEvent(instance, ev.triggerId)) {
    return { plan: null, reason: "duplicate-trigger" };
  }
  const env = {
    state: instance.stateData,
    params: instance.params,
    event: ev.payload,
    now: opts.now
  };
  const matchedEffects = [];
  const matchedClauseIds = [];
  const updates = [];
  let nextState;
  let anyMatched = false;
  for (const clause of instance.clauses) {
    if (!triggerMatches(clause.on, ev)) continue;
    anyMatched = true;
    if (clause.on.requiresChannelToken && ev.kind === "protocol" && ev.channelTokenValid !== true) {
      return {
        plan: null,
        reason: "rejected",
        reasonDetail: `\u6761\u6B3E ${clause.id} \u8981\u6C42 channelToken \u6821\u9A8C\u901A\u8FC7\u7684\u534F\u8BAE\u4E8B\u4EF6`
      };
    }
    const enabled = clause.on.enabledStates ?? DEFAULT_ENABLED_STATES;
    if (!enabled.includes(instance.state)) continue;
    if (clause.when !== void 0) {
      let cond;
      try {
        cond = evaluateExpression(clause.when, { vars: env, seed: instance.seed });
      } catch (e) {
        return { plan: null, reason: "eval-error", reasonDetail: `\u6761\u6B3E ${clause.id} when \u6C42\u503C\u5931\u8D25: ${e.message}` };
      }
      if (!cond) continue;
    }
    for (const spec of clause.then) {
      try {
        matchedEffects.push(resolveEffectSpec(spec, env, instance.stateData, instance.seed));
      } catch (e) {
        return { plan: null, reason: "eval-error", reasonDetail: `\u6761\u6B3E ${clause.id} effect \u89E3\u6790\u5931\u8D25: ${e.message}` };
      }
    }
    matchedClauseIds.push(clause.id);
    for (const u of clause.updates ?? []) {
      try {
        if (u.op === "push") {
          const userId = evalString((u.userIdExpr ?? "event.userId").trim().startsWith("expr:") ? (u.userIdExpr ?? "").slice(5).trim() : u.userIdExpr ?? "event.userId", { vars: env, seed: instance.seed });
          const amount = evalNumber((u.amountExpr ?? "0").trim().startsWith("expr:") ? (u.amountExpr ?? "").slice(5).trim() : u.amountExpr ?? "0", { vars: env, seed: instance.seed });
          updates.push({ field: u.field, op: "push", userId, amount });
        } else {
          const v = resolveNum(u.value, env, `updates.${u.field}`, instance.seed);
          updates.push({ field: u.field, op: u.op, value: v });
        }
      } catch (e) {
        return { plan: null, reason: "eval-error", reasonDetail: `\u6761\u6B3E ${clause.id} updates.${u.field} \u6C42\u503C\u5931\u8D25: ${e.message}` };
      }
    }
    for (const eff of clause.then) {
      if (eff.type === "setState" && typeof eff.to === "string" && !eff.to.startsWith("expr:")) {
        nextState = eff.to;
      } else if (eff.type === "setState" && typeof eff.to === "string") {
        const s = evalString(eff.to.slice(5).trim(), { vars: env, seed: instance.seed });
        nextState = s;
      }
    }
  }
  if (!anyMatched) {
    return { plan: null, reason: "no-matching-clause" };
  }
  if (matchedClauseIds.length === 0) {
    return { plan: null, reason: "condition-not-met" };
  }
  if (nextState !== void 0 && !isValidTransition(instance.state, nextState)) {
    return {
      plan: null,
      reason: "rejected",
      reasonDetail: `\u975E\u6CD5\u72B6\u6001\u8FC1\u79FB ${instance.state} \u2192 ${nextState}`
    };
  }
  return {
    plan: {
      contractId: instance.id,
      templateKey: instance.templateKey,
      clauseIds: matchedClauseIds,
      idempotencyKey: `${instance.id}:${ev.triggerId}`,
      trigger: ev,
      effects: matchedEffects,
      updates,
      nextState,
      shadow: !instance.autoExecute,
      createdAt: opts.now
    }
  };
}
function cloneDeep(v) {
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneDeep(val);
    return out;
  }
  return v;
}
function applyUpdates(stateData, updates) {
  const next = cloneDeep(stateData);
  for (const u of updates) {
    const segs = u.field.split(".");
    let cur = next;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
      cur = cur[seg];
    }
    const leaf = segs[segs.length - 1];
    if (u.op === "push") {
      if (!Array.isArray(cur[leaf])) cur[leaf] = [];
      cur[leaf].push({ userId: u.userId, amount: u.amount });
    } else if (u.op === "set") {
      cur[leaf] = u.value;
    } else {
      const prev = typeof cur[leaf] === "number" ? cur[leaf] : 0;
      cur[leaf] = prev + (u.value ?? 0);
    }
  }
  return next;
}

// src/contracts/engine/ledger.ts
var GENESIS_HASH = "0".repeat(64);
function computeEventHash(body, prevHash) {
  return sha256hex(prevHash + "\u241F" + canonicalize(body));
}
function appendEvent(history, body) {
  const last = history[history.length - 1];
  const seq = last ? last.seq + 1 : 0;
  const prevHash = last ? last.hash : GENESIS_HASH;
  const full = { seq, ...body };
  return {
    ...full,
    prevHash,
    hash: computeEventHash(full, prevHash)
  };
}
function verifyChain(events) {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i) {
      return { intact: false, brokenAt: e.seq, length: events.length };
    }
    if (e.prevHash !== prev) {
      return { intact: false, brokenAt: e.seq, length: events.length };
    }
    const recomputed = computeEventHash(
      { seq: e.seq, at: e.at, type: e.type, actorId: e.actorId, payload: e.payload },
      e.prevHash
    );
    if (recomputed !== e.hash) {
      return { intact: false, brokenAt: e.seq, length: events.length };
    }
    prev = e.hash;
  }
  return { intact: true, length: events.length };
}
function merkleRoot(hashes) {
  if (hashes.length === 0) return GENESIS_HASH;
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256hex(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

// src/contracts/templates/groupBuy.ts
var GROUP_BUY_TEMPLATE = {
  key: "group-buy",
  family: "teamup",
  version: 1,
  title: "\u62FC\u56E2\u5408\u7EA6",
  description: "N \u4EBA\u6210\u56E2\u4EAB\u56E2\u8D2D\u4EF7\uFF1B\u6EE1\u5458\u6216\u5230\u671F\u8FBE\u6807\u81EA\u52A8\u4EA4\u5272\u7ED9\u53D1\u8D77\u4EBA\uFF0C\u672A\u8FBE\u6807\u5168\u989D\u81EA\u52A8\u9000\u6B3E\u3002\u8D44\u91D1\u5168\u7A0B\u670D\u52A1\u7AEF\u6258\u7BA1\u3002",
  riskLevel: "low",
  requiresAudit: false,
  initialState: "signing",
  effectsWhitelist: ["walletTransfer", "refundAll", "setState", "notify", "openDispute"],
  governanceTopics: [],
  paramsSchema: {
    gameId: { type: "string", description: "\u5173\u8054\u6E38\u620F\uFF08\u53EF\u9009\uFF09" },
    skuId: { type: "string", description: "\u5546\u54C1\u6807\u8BC6\uFF08\u53EF\u9009\uFF09" },
    itemTitle: { type: "string", required: true, min: 1, max: 50, description: "\u62FC\u56E2\u5546\u54C1\u540D" },
    initiatorId: { type: "string", required: true, min: 1, description: "\u53D1\u8D77\u4EBA\uFF08\u6536\u6B3E\u4E0E\u5C65\u7EA6\u65B9\uFF09" },
    unitPrice: { type: "number", required: true, min: 1, description: "\u5355\u4E70\u5BF9\u7167\u4EF7" },
    groupPrice: { type: "number", required: true, min: 1, description: "\u6210\u56E2\u5355\u4EF7" },
    minMembers: { type: "number", required: true, min: 2, max: 500, description: "\u6700\u4F4E\u6210\u56E2\u4EBA\u6570" },
    maxMembers: { type: "number", required: true, min: 2, max: 500, description: "\u4EBA\u6570\u4E0A\u9650" },
    openAt: { type: "number", required: true, description: "\u5F00\u56E2\u65F6\u95F4\u6233" },
    closeAt: { type: "number", required: true, description: "\u622A\u56E2\u65F6\u95F4\u6233" },
    currency: { type: "enum", required: true, enumValues: ["gameCoins", "aCoins"], description: "\u7ED3\u7B97\u5E01\u79CD" },
    perUserLimit: { type: "number", required: true, min: 1, description: "\u6BCF\u4EBA\u9650\u8D2D\u4EFD\u6570" },
    disputeWindowMs: { type: "number", required: true, min: 0, max: 7 * 24 * 3600 * 1e3, description: "\u4EA4\u5272\u540E\u6311\u6218\u7A97\u53E3" }
  },
  clauses: [
    {
      id: "gb-join",
      title: "\u52A0\u5165\u62FC\u56E2\uFF1A\u8D27\u6B3E\u8FDB\u6258\u7BA1",
      description: "\u6210\u5458\u6309\u6210\u56E2\u4EF7\u4ED8\u6B3E\uFF0C\u8D44\u91D1\u7531\u5E73\u53F0\u6258\u7BA1\u8D26\u6237\u9501\u5B9A\uFF1B\u4E8B\u4EF6\u94FE\u8BB0\u5F55\u6BCF\u7B14\u51FA\u8D44\u3002",
      on: { id: "t-join", kind: "manual", action: "join", enabledStates: ["signing"] },
      when: "now <= params.closeAt && state.memberCount < params.maxMembers && countUser(state.contributions, event.userId) < params.perUserLimit",
      then: [
        {
          type: "walletTransfer",
          toUserId: "escrow",
          fromUserId: "expr: event.userId",
          currency: "expr: params.currency",
          amount: "expr: params.groupPrice",
          purpose: "payment",
          reason: "\u62FC\u56E2\u8D27\u6B3E\u6258\u7BA1"
        }
      ],
      updates: [
        { field: "memberCount", op: "add", value: 1 },
        { field: "contributions", op: "push", value: 0, userIdExpr: "event.userId", amountExpr: "params.groupPrice" }
      ]
    },
    {
      id: "gb-reach-max",
      title: "\u6EE1\u5458\u5373\u6210\u56E2\u4EA4\u5272",
      on: { id: "t-reach-max", kind: "manual", action: "join", enabledStates: ["signing"] },
      // 注意：同一触发事件内 updates 在全部条款评估后才应用，join 类判定用 +1 模拟本次加入后
      when: "state.memberCount + 1 >= params.maxMembers",
      then: [
        {
          type: "walletTransfer",
          toUserId: "expr: params.initiatorId",
          currency: "expr: params.currency",
          amount: "expr: (state.memberCount + 1) * params.groupPrice",
          purpose: "payment",
          reason: "\u6EE1\u5458\u6210\u56E2\u4EA4\u5272"
        },
        { type: "setState", to: "settling", reason: "\u6210\u56E2\u4EA4\u5272\uFF0C\u8FDB\u5165\u6311\u6218\u7A97\u53E3" }
      ]
    },
    {
      id: "gb-settle-signing",
      title: "\u5230\u671F\u8FBE\u6807\u4EA4\u5272\uFF08\u672A\u6EE1\u5458\uFF09",
      on: { id: "t-settle-signing", kind: "cron", schedule: "deadline-check", enabledStates: ["signing"] },
      when: "now > params.closeAt && state.memberCount >= params.minMembers && state.memberCount < params.maxMembers",
      then: [
        {
          type: "walletTransfer",
          toUserId: "expr: params.initiatorId",
          currency: "expr: params.currency",
          amount: "expr: state.memberCount * params.groupPrice",
          purpose: "payment",
          reason: "\u5230\u671F\u8FBE\u6807\u4EA4\u5272"
        },
        { type: "setState", to: "settling", reason: "\u4EA4\u5272\u5B8C\u6210\uFF0C\u8FDB\u5165\u6311\u6218\u7A97\u53E3" }
      ]
    },
    {
      id: "gb-refund",
      title: "\u5230\u671F\u672A\u6210\u56E2\u5168\u989D\u81EA\u52A8\u9000\u6B3E",
      on: { id: "t-refund", kind: "cron", schedule: "deadline-check", enabledStates: ["signing"] },
      when: "now > params.closeAt && state.memberCount < params.minMembers",
      then: [{ type: "refundAll", purpose: "payment", reason: "\u6D41\u56E2\u5168\u989D\u81EA\u52A8\u9000\u6B3E" }, { type: "setState", to: "refunded", reason: "\u6D41\u56E2" }]
    },
    {
      id: "gb-confirm",
      title: "\u6311\u6218\u7A97\u53E3\u7ED3\u675F \u2192 \u7EC8\u5C40",
      on: { id: "t-confirm", kind: "cron", schedule: "deadline-check", enabledStates: ["settling"] },
      when: "now > params.closeAt + params.disputeWindowMs",
      then: [{ type: "setState", to: "fulfilled", reason: "\u6311\u6218\u7A97\u53E3\u7ED3\u675F\uFF0C\u5408\u7EA6\u7EC8\u5C40" }]
    },
    {
      id: "gb-dispute",
      title: "\u53D1\u8D77\u6311\u6218",
      on: { id: "t-dispute", kind: "manual", action: "dispute", enabledStates: ["settling", "active"] },
      when: "true",
      then: [
        { type: "openDispute", byUserId: "expr: event.userId", reason: "expr: event.reason" },
        { type: "setState", to: "disputed", reason: 'expr: "\u6311\u6218\u4EBA:" + event.userId' }
      ]
    }
  ]
};

// src/contracts/templates/teamQuest.ts
var TEAM_QUEST_TEMPLATE = {
  key: "team-quest",
  family: "teamup",
  version: 1,
  title: "\u7EC4\u56E2\u4EFB\u52A1\u5408\u7EA6",
  description: "\u53D1\u8D77\u4EBA\u81EA\u52A8\u5165\u56E2\uFF1B\u8FBE\u6700\u4F4E\u4EBA\u6570\u5373\u5F00\u56E2\uFF0C\u8FBE\u6700\u9AD8\u4EBA\u6570\u540E\u5C01\u56E2\u3002\u56E2\u5458\u7F34\u4FDD\u8BC1\u91D1\u5165\u6258\u7BA1\u3001\u53D1\u8D77\u4EBA\u6CE8\u5165\u5956\u6C60\uFF1B\u8D21\u732E\u70B9\u6570\u6309\u5408\u7EA6\u5199\u660E\u7684\u89C4\u5219\u786E\u5B9A\uFF08\u6E38\u620F\u4E8B\u4EF6/\u56E2\u957F\u4EE3\u62A5\uFF09\uFF1B\u622A\u6B62\u81EA\u52A8\u7ED3\u7B97\uFF1A\u5148\u62BD\u56E2\u957F\u7BA1\u7406\u8D39\uFF08\u6BD4\u4F8B\u53EF\u9009\uFF09\uFF0C\u4F59\u4E0B\u5956\u6C60\u6309\u8D21\u732E\u5360\u6BD4\u5206\u914D + \u4FDD\u8BC1\u91D1\u5168\u9000\uFF1B\u672A\u6210\u56E2\u6216\u672A\u6CE8\u8D44\u81EA\u52A8\u9000\u6B3E\u3002",
  riskLevel: "medium",
  requiresAudit: false,
  initialState: "signing",
  effectsWhitelist: ["walletTransfer", "splitPayout", "refundAll", "penalize", "setState", "notify", "openDispute"],
  governanceTopics: [],
  paramsSchema: {
    questId: { type: "string", required: true, min: 1, description: "\u5173\u8054\u4EFB\u52A1" },
    gameId: { type: "string", description: "\u5173\u8054\u6E38\u620F\uFF08\u53EF\u9009\uFF09" },
    initiatorId: { type: "string", required: true, min: 1, description: "\u56E2\u957F" },
    questTitle: { type: "string", required: true, min: 1, max: 60, description: "\u4EFB\u52A1\u6807\u9898" },
    minMembers: { type: "number", required: true, min: 2, max: 100, description: "\u6700\u4F4E\u5F00\u56E2\u4EBA\u6570" },
    maxMembers: { type: "number", required: true, min: 2, max: 100, description: "\u4EBA\u6570\u4E0A\u9650" },
    recruitmentDeadline: { type: "number", required: true, description: "\u62DB\u52DF\u622A\u6B62" },
    taskDeadline: { type: "number", required: true, description: "\u4EFB\u52A1\u622A\u6B62" },
    rewardPool: {
      type: "object",
      required: true,
      fields: {
        amount: { type: "number", required: true, min: 0, description: "\u5956\u6C60\u91D1\u989D\uFF080=\u65E0\u5956\u6C60\uFF0C\u4EC5\u4FDD\u8BC1\u91D1\u8FD4\u8FD8\uFF09" },
        currency: { type: "enum", required: true, enumValues: ["gameCoins", "aCoins"], description: "\u5E01\u79CD" }
      }
    },
    memberBond: { type: "number", required: true, min: 0, description: "\u56E2\u5458\u4FDD\u8BC1\u91D1\uFF080=\u514D\u4FDD\u8BC1\u91D1\uFF09" },
    earlyExitBps: { type: "number", required: true, min: 0, max: 1e4, description: "\u4E2D\u9014\u9000\u51FA\u7F5A\u6CA1\u6BD4\u4F8B(bps)" },
    leaderFeeBps: { type: "number", required: true, min: 0, max: 5e3, description: "\u56E2\u957F\u7BA1\u7406\u8D39(bps)\uFF1A\u7ED3\u7B97\u65F6\u5148\u4ECE\u5956\u6C60\u62BD\u53D6\u7ED9\u56E2\u957F\uFF0C\u5176\u4F59\u6309\u8D21\u732E\u5206\u914D" },
    contributionRule: { type: "string", required: true, min: 1, max: 200, description: "\u8D21\u732E\u70B9\u6570\u786E\u5B9A\u89C4\u5219\uFF08\u7ED3\u7B97\u4F9D\u636E\uFF0C\u987B\u5728\u5408\u7EA6\u4E2D\u5199\u660E\uFF09" },
    protocolEvent: { type: "string", required: true, min: 1, description: "\u8D21\u732E\u4E8B\u4EF6\u540D\uFF08GAME_EVENT:XXX\uFF09" },
    disputeWindowMs: { type: "number", required: true, min: 0, max: 7 * 24 * 3600 * 1e3, description: "\u7ED3\u7B97\u540E\u6311\u6218\u7A97\u53E3" }
  },
  clauses: [
    {
      id: "tq-join",
      title: "\u52A0\u5165\u56E2\u961F\uFF1A\u4FDD\u8BC1\u91D1\u8FDB\u6258\u7BA1\uFF082026-10-20 \u4FEE\u6B63\uFF1A\u6309\u6700\u9AD8\u4EBA\u6570\u5C01\u56E2\uFF09",
      description: "\u62DB\u52DF\u671F\u4E0E\u4EFB\u52A1\u8FDB\u884C\u4E2D\u5747\u53EF\u52A0\u5165\uFF0C\u4EBA\u6570\u8FBE\u5230\u6700\u9AD8\u6210\u56E2\u4EBA\u6570\u540E\u5C01\u56E2\uFF08\u53D1\u8D77\u4EBA\u81EA\u52A8\u8BA1\u5165\uFF09\u3002",
      on: { id: "t-join", kind: "manual", action: "join", enabledStates: ["signing", "active"] },
      when: "now <= params.recruitmentDeadline && state.memberCount < params.maxMembers && countUser(state.contributions, event.userId) < 1",
      then: [
        {
          type: "walletTransfer",
          toUserId: "escrow",
          fromUserId: "expr: event.userId",
          currency: "expr: params.rewardPool.currency",
          amount: "expr: params.memberBond",
          purpose: "bond",
          reason: "\u56E2\u5458\u4FDD\u8BC1\u91D1\u6258\u7BA1"
        }
      ],
      updates: [
        { field: "memberCount", op: "add", value: 1 },
        { field: "contributions", op: "push", value: 0, userIdExpr: "event.userId", amountExpr: "0" }
      ]
    },
    {
      id: "tq-reach-quorum",
      title: "\u8FBE\u5230\u6700\u4F4E\u4EBA\u6570 \u2192 \u5F00\u56E2",
      on: { id: "t-quorum", kind: "manual", action: "join", enabledStates: ["signing"] },
      // +1 约定：同触发内 updates 在全部条款评估后才应用
      when: "state.memberCount + 1 >= params.minMembers",
      then: [{ type: "setState", to: "active", reason: "\u8FBE\u5230\u6700\u4F4E\u5F00\u56E2\u4EBA\u6570" }]
    },
    {
      id: "tq-manual-open",
      title: "\u56E2\u957F\u624B\u52A8\u6210\u56E2\uFF08\u{1F195} 2026-10-20\uFF09",
      description: "\u4EBA\u6570\u5DF2\u8FBE\u6700\u4F4E\u5F00\u56E2\u4EBA\u6570\u540E\uFF0C\u56E2\u957F\u53EF\u4E0D\u7B49\u62DB\u52DF\u622A\u6B62\uFF0C\u63D0\u524D\u624B\u52A8\u5F00\u56E2\uFF08\u8FDB\u5165 active \u540E\u5373\u53EF\u6CE8\u5165\u5956\u6C60\u5E76\u5F00\u59CB\u4E0A\u62A5\u8D21\u732E\uFF09\u3002",
      on: { id: "t-manual-open", kind: "manual", action: "open-team", enabledStates: ["signing"] },
      when: "state.memberCount >= params.minMembers",
      then: [{ type: "setState", to: "active", reason: 'expr: "\u56E2\u957F\u624B\u52A8\u6210\u56E2\uFF0C\u5F53\u524D " + state.memberCount + " \u4EBA"' }]
    },
    {
      id: "tq-fund-pool",
      title: "\u56E2\u957F\u6CE8\u5165\u5956\u6C60",
      on: { id: "t-fund", kind: "manual", action: "fund-pool", enabledStates: ["active"] },
      when: "params.rewardPool.amount > 0 && !state.poolFunded",
      then: [
        {
          type: "walletTransfer",
          toUserId: "escrow",
          fromUserId: "expr: params.initiatorId",
          currency: "expr: params.rewardPool.currency",
          amount: "expr: params.rewardPool.amount",
          purpose: "pool",
          reason: "\u56E2\u957F\u6CE8\u5165\u5956\u6C60"
        }
      ],
      updates: [{ field: "poolFunded", op: "set", value: 1 }]
    },
    {
      id: "tq-progress",
      title: "\u4EFB\u52A1\u8FDB\u5EA6\u4E0A\u62A5\uFF08\u5F3A\u5236 channelToken\uFF09",
      description: "\u8FDD\u7EA6/\u5206\u914D\u5224\u5B9A\u7684\u4E8B\u5B9E\u6E90\uFF1A\u7F3A\u5931\u6216\u65E0\u6548 channelToken \u7684\u534F\u8BAE\u4E8B\u4EF6\u4E00\u5F8B\u62D2\u7EDD\u3002",
      on: {
        id: "t-progress",
        kind: "protocol",
        match: "GAME_EVENT:*",
        requiresChannelToken: true,
        enabledStates: ["active"]
      },
      when: "event.points != null",
      then: [{ type: "notify", message: 'expr: "\u8D21\u732E+[" + event.points + "]" + event.userId', reason: "\u8D21\u732E\u8BB0\u5F55" }],
      updates: [
        { field: "score", op: "add", value: "expr: event.points" },
        { field: "contributions", op: "push", value: 0, userIdExpr: "event.userId", amountExpr: "event.points" }
      ]
    },
    {
      id: "tq-leave",
      title: "\u4E2D\u9014\u9000\u51FA \u2192 \u6309\u7EA6\u7F5A\u6CA1",
      on: { id: "t-leave", kind: "manual", action: "leave", enabledStates: ["signing", "active"] },
      when: "params.earlyExitBps > 0",
      then: [
        {
          type: "penalize",
          userId: "expr: event.userId",
          currency: "expr: params.rewardPool.currency",
          amount: "expr: params.memberBond * params.earlyExitBps / 10000",
          forfeitTo: "treasury",
          purpose: "bond",
          reason: "\u4E2D\u9014\u9000\u51FA\u8FDD\u7EA6\u7F5A\u6CA1"
        },
        {
          type: "walletTransfer",
          toUserId: "expr: event.userId",
          currency: "expr: params.rewardPool.currency",
          amount: "expr: params.memberBond * (10000 - params.earlyExitBps) / 10000",
          purpose: "bond",
          reason: "\u4FDD\u8BC1\u91D1\u5269\u4F59\u9000\u8FD8"
        }
      ],
      updates: [{ field: "memberCount", op: "add", value: -1 }]
    },
    {
      id: "tq-settle",
      title: "\u622A\u6B62\u81EA\u52A8\u7ED3\u7B97\uFF1A\u5148\u62BD\u56E2\u957F\u7BA1\u7406\u8D39\uFF0C\u4F59\u4E0B\u5956\u6C60\u6309\u8D21\u732E\u5206\u914D + \u4FDD\u8BC1\u91D1\u9000\u8FD8",
      description: "\u7ED3\u7B97\u987A\u5E8F\uFF082026-10-18\uFF09\uFF1A\u2460 \u56E2\u957F\u7BA1\u7406\u8D39 = \u5956\u6C60 \xD7 leaderFeeBps/10000 \u5212\u7ED9\u56E2\u957F\uFF1B\u2461 \u5269\u4F59\u5956\u6C60\u6309\u8D21\u732E\u5360\u6BD4\u5206\u914D\uFF1B\u2462 \u4FDD\u8BC1\u91D1\u5168\u989D\u9000\u8FD8\u3002\u7BA1\u7406\u8D39\u5728\u5206\u914D\u524D\u62BD\u53D6\uFF0C\u56E2\u5458\u5206\u914D\u57FA\u6570=\u5956\u6C60\xD7(1-\u7BA1\u7406\u8D39\u7387)\u3002",
      on: { id: "t-settle", kind: "cron", schedule: "deadline-check", enabledStates: ["active"] },
      // 🆕 注资守卫：奖池未注入（poolFunded≠1 且 amount>0）时不结算，避免 splitPayout 从空托管转出 → 死信卡死保证金
      when: "now > params.taskDeadline && state.memberCount >= params.minMembers && state.score > 0 && (params.rewardPool.amount == 0 || state.poolFunded == 1)",
      then: [
        {
          type: "walletTransfer",
          toUserId: "expr: params.initiatorId",
          fromUserId: "escrow",
          currency: "expr: params.rewardPool.currency",
          amount: "expr: params.rewardPool.amount * params.leaderFeeBps / 10000",
          purpose: "pool",
          reason: "\u56E2\u957F\u7BA1\u7406\u8D39\uFF08\u6309\u7EA6\u62BD\u53D6\uFF09"
        },
        {
          type: "splitPayout",
          currency: "expr: params.rewardPool.currency",
          table: {
            kind: "byField",
            stateField: "contributions",
            amountField: "amount",
            mode: "share",
            poolAmount: "expr: params.rewardPool.amount * (10000 - params.leaderFeeBps) / 10000"
          },
          purpose: "pool",
          reason: "\u5269\u4F59\u5956\u6C60\u6309\u8D21\u732E\u5360\u6BD4\u5206\u914D"
        },
        { type: "refundAll", purpose: "bond", reason: "\u4EFB\u52A1\u5B8C\u6210\uFF0C\u4FDD\u8BC1\u91D1\u5168\u989D\u9000\u8FD8" },
        { type: "setState", to: "settling", reason: "\u7ED3\u7B97\u5B8C\u6210\uFF0C\u8FDB\u5165\u6311\u6218\u7A97\u53E3" }
      ]
    },
    {
      id: "tq-settle-empty",
      title: "\u96F6\u8D21\u732E\u7ED3\u7B97\uFF1A\u5956\u6C60\u9000\u56DE\u53D1\u8D77\u4EBA + \u4FDD\u8BC1\u91D1\u9000\u8FD8",
      description: "B-24 \u515C\u5E95\uFF1A\u5168\u90E8\u6210\u5458\u96F6\u8D21\u732E\u65F6\u65E0\u5206\u914D\u5BF9\u8C61\uFF0C\u5956\u6C60\u539F\u8DEF\u9000\u56DE\uFF0C\u907F\u514D\u8D44\u91D1\u5361\u6B7B\u6258\u7BA1\u3002",
      on: { id: "t-settle-empty", kind: "cron", schedule: "deadline-check", enabledStates: ["active"] },
      // 🆕 同 tq-settle：注资守卫（零贡献退发起人奖池也需托管里真有钱）
      when: "now > params.taskDeadline && state.memberCount >= params.minMembers && state.score <= 0 && (params.rewardPool.amount == 0 || state.poolFunded == 1)",
      then: [
        {
          type: "walletTransfer",
          toUserId: "expr: params.initiatorId",
          currency: "expr: params.rewardPool.currency",
          amount: "expr: params.rewardPool.amount",
          purpose: "pool",
          reason: "\u96F6\u8D21\u732E\uFF0C\u5956\u6C60\u9000\u56DE\u53D1\u8D77\u4EBA"
        },
        { type: "refundAll", purpose: "bond", reason: "\u4EFB\u52A1\u96F6\u8D21\u732E\uFF0C\u4FDD\u8BC1\u91D1\u5168\u989D\u9000\u8FD8" },
        { type: "setState", to: "settling", reason: "\u7ED3\u7B97\u5B8C\u6210\uFF0C\u8FDB\u5165\u6311\u6218\u7A97\u53E3" }
      ]
    },
    {
      id: "tq-refund",
      title: "\u672A\u6210\u56E2\u81EA\u52A8\u9000\u6B3E",
      on: { id: "t-refund", kind: "cron", schedule: "deadline-check", enabledStates: ["signing"] },
      when: "now > params.recruitmentDeadline && state.memberCount < params.minMembers",
      then: [{ type: "refundAll", purpose: "bond", reason: "\u672A\u6210\u56E2\u5168\u989D\u81EA\u52A8\u9000\u6B3E" }, { type: "setState", to: "refunded", reason: "\u672A\u6210\u56E2" }]
    },
    {
      id: "tq-settle-unfunded",
      title: "\u622A\u6B62\u672A\u6CE8\u8D44\u515C\u5E95\uFF1A\u4FDD\u8BC1\u91D1\u9000\u8FD8\uFF082026-10-10 \u5BA1\u67E5\u65B0\u589E\uFF09",
      description: "\u4EBA\u6570\u8FBE\u6807\u4F46\u56E2\u957F\u59CB\u7EC8\u672A\u6CE8\u5165\u5956\u6C60\u2014\u2014tq-settle/tq-settle-empty \u56E0\u6CE8\u8D44\u5B88\u536B\u4E0D\u89E6\u53D1\uFF0C\u82E5\u7F3A\u6B64\u6761\u6B3E\u4FDD\u8BC1\u91D1\u5C06\u6C38\u4E45\u5361\u6B7B\u6258\u7BA1\u3002",
      on: { id: "t-settle-unfunded", kind: "cron", schedule: "deadline-check", enabledStates: ["active"] },
      when: "now > params.taskDeadline && state.memberCount >= params.minMembers && params.rewardPool.amount > 0 && state.poolFunded != 1",
      then: [
        { type: "refundAll", purpose: "bond", reason: "\u5956\u6C60\u672A\u6CE8\u5165\uFF0C\u4FDD\u8BC1\u91D1\u5168\u989D\u9000\u8FD8" },
        { type: "setState", to: "settling", reason: "\u672A\u6CE8\u8D44\u515C\u5E95\u7ED3\u7B97\uFF0C\u8FDB\u5165\u6311\u6218\u7A97\u53E3" }
      ]
    },
    {
      id: "tq-settle-understaffed",
      title: "\u622A\u6B62\u4EBA\u6570\u4E0D\u8DB3\u515C\u5E95\uFF1A\u5956\u6C60\u9000\u53D1\u8D77\u4EBA + \u4FDD\u8BC1\u91D1\u9000\u8FD8\uFF082026-10-10 \u5BA1\u67E5\u65B0\u589E\uFF09",
      description: "active \u72B6\u6001\u4E2D\u9014\u9000\u51FA\u81F4\u4EBA\u6570\u4F4E\u4E8E minMembers \u65F6\uFF0Ctq-settle\uFF08\u8981\u6C42\u2265min\uFF09\u4E0E tq-refund\uFF08\u4EC5 signing\uFF09\u5747\u4E0D\u8986\u76D6\u2014\u2014\u82E5\u7F3A\u6B64\u6761\u6B3E\u6258\u7BA1\u8D44\u91D1\u6C38\u4E45\u5361\u6B7B\u3002refundAll(pool) \u6309\u51FA\u8D44\u4EBA\u539F\u8DEF\u9000\u56DE\uFF08=\u53D1\u8D77\u4EBA\uFF09\uFF0C\u672A\u6CE8\u8D44\u5219\u65E0\u6761\u76EE\u81EA\u7136\u7A7A\u64CD\u4F5C\u3002",
      on: { id: "t-settle-understaffed", kind: "cron", schedule: "deadline-check", enabledStates: ["active"] },
      when: "now > params.taskDeadline && state.memberCount < params.minMembers",
      then: [
        { type: "refundAll", purpose: "pool", reason: "\u4EBA\u6570\u4E0D\u8DB3\uFF0C\u5956\u6C60\u6309\u51FA\u8D44\u4EBA\u539F\u8DEF\u9000\u56DE" },
        { type: "refundAll", purpose: "bond", reason: "\u4EBA\u6570\u4E0D\u8DB3\uFF0C\u4FDD\u8BC1\u91D1\u5168\u989D\u9000\u8FD8" },
        { type: "setState", to: "settling", reason: "\u4EBA\u6570\u4E0D\u8DB3\u515C\u5E95\u7ED3\u7B97\uFF0C\u8FDB\u5165\u6311\u6218\u7A97\u53E3" }
      ]
    },
    {
      id: "tq-confirm",
      title: "\u6311\u6218\u7A97\u53E3\u7ED3\u675F \u2192 \u7EC8\u5C40",
      on: { id: "t-confirm", kind: "cron", schedule: "deadline-check", enabledStates: ["settling"] },
      when: "now > params.taskDeadline + params.disputeWindowMs",
      then: [{ type: "setState", to: "fulfilled", reason: "\u6311\u6218\u7A97\u53E3\u7ED3\u675F\uFF0C\u5408\u7EA6\u7EC8\u5C40" }]
    },
    {
      id: "tq-dispute",
      title: "\u53D1\u8D77\u6311\u6218",
      on: { id: "t-dispute", kind: "manual", action: "dispute", enabledStates: ["settling", "active"] },
      when: "true",
      then: [
        { type: "openDispute", byUserId: "expr: event.userId", reason: "expr: event.reason" },
        { type: "setState", to: "disputed", reason: 'expr: "\u6311\u6218\u4EBA:" + event.userId' }
      ]
    }
  ]
};

// src/contracts/templates/gso.ts
var GSO_TEMPLATE = {
  key: "gso",
  family: "community_revenue",
  version: 1,
  title: "\u6E38\u620F\u6536\u76CA\u6743\u8BA4\u8D2D\u5408\u7EA6\uFF08GSO\uFF09",
  description: "\u6E38\u620F\u65B9\u51FA\u8BA9\u6E38\u620F\u6536\u76CA\u5206\u6210\u6743\uFF0C\u793E\u533A\u8BA4\u8D2D\uFF1B\u8FBE\u6807\u81EA\u52A8\u4EA4\u5272\u5E76\u94F8\u6536\u76CA\u5206\u6210\u51ED\u8BC1\uFF08RSV\uFF0C\u5E26\u9501\u5B9A\u671F\uFF09\uFF0C\u6536\u76CA\u6309\u4EFD\u989D\u81EA\u52A8\u5206\u8D26\u3002\u4EC5\u7EB3\u5165\u5E73\u53F0\u53EF\u89C2\u6D4B\u6536\u76CA\u3002\u8D85\u989D\u8BA4\u8D2D\u89C4\u5219\uFF1A\u5168\u989D\u4EA4\u5272\u3001RSV \u6309\u8BA4\u8D2D\u91D1\u989D\u5360\u6BD4\u5206\u914D\uFF1BhardCap/perUserCap \u5148\u5230\u5148\u5F97\uFF08\u8D85\u989D\u90E8\u5206\u4E0D\u9000\u56DE\u3001\u4E0D\u7F29\u51CF\uFF09\u3002\u53EA\u6709\u6E38\u620F\u53D1\u5E03\u8005\u53EF\u53D1\u884C\u3002",
  riskLevel: "high",
  requiresAudit: true,
  // GSO 必须平台审核（合规前置）
  initialState: "signing",
  effectsWhitelist: [
    "walletTransfer",
    "refundAll",
    "mintShareVouchers",
    "splitPayout",
    "grantGovernanceWeight",
    "setState",
    "notify",
    "openDispute"
  ],
  governanceTopics: ["ADJUST_PRICE", "GAME_CONFIG", "MINT_CURRENCY"],
  paramsSchema: {
    gameId: { type: "string", required: true, min: 1, description: "\u6807\u7684\u6E38\u620F" },
    issuerId: { type: "string", required: true, min: 1, description: "\u51FA\u8BA9\u65B9\uFF08\u6E38\u620F\u65B9\uFF09" },
    gameName: { type: "string", required: true, min: 1, max: 60, description: "\u6E38\u620F\u540D" },
    raiseTarget: { type: "number", required: true, min: 1, description: "\u52DF\u8D44\u76EE\u6807" },
    currency: { type: "enum", required: true, enumValues: ["gameCoins", "aCoins"], description: "\u8BA4\u8D2D\u5E01\u79CD" },
    revenueShareBps: { type: "number", required: true, min: 1, max: 1e4, description: "\u51FA\u8BA9\u6536\u76CA\u6BD4\u4F8B(bps)" },
    governanceShareBps: { type: "number", required: true, min: 0, max: 1e4, description: "\u51FA\u8BA9\u6CBB\u7406\u6BD4\u4F8B(bps)" },
    openAt: { type: "number", required: true, description: "\u5F00\u552E\u65F6\u95F4" },
    closeAt: { type: "number", required: true, description: "\u622A\u6B62\u65F6\u95F4" },
    softCap: { type: "number", required: true, min: 1, description: "\u6700\u4F4E\u6210\u7B79\u989D" },
    hardCap: { type: "number", min: 1, description: "\u4E0A\u9650\uFF08\u8D85\u989D\u914D\u552E\u62E6\u622A\uFF09" },
    perUserCap: { type: "number", required: true, min: 1, description: "\u5355\u4EBA\u8BA4\u8D2D\u4E0A\u9650\uFF08\u5408\u89C4\uFF09" },
    coolDownMs: { type: "number", required: true, min: 0, description: "\u51B7\u9759\u671F" },
    lockupMs: { type: "number", required: true, min: 0, description: "RSV \u9501\u5B9A\u671F\uFF08\u9632\u7092\u4F5C\uFF09" },
    revenueSources: {
      type: "array",
      required: true,
      minItems: 1,
      itemRule: {
        type: "enum",
        enumValues: ["market_commission", "content_consume", "store_sale", "item_sale"]
      },
      description: "\u6536\u76CA\u6765\u6E90\uFF08\u4EC5\u5E73\u53F0\u53EF\u89C2\u6D4B\uFF09"
    },
    settlementCron: { type: "enum", required: true, enumValues: ["weekly", "monthly"], description: "\u7ED3\u7B97\u5468\u671F" },
    governableTopics: { type: "array", itemRule: { type: "string" }, description: "\u6CBB\u7406\u767D\u540D\u5355" },
    disputeWindowMs: { type: "number", required: true, min: 0, max: 7 * 24 * 3600 * 1e3, description: "\u4EA4\u5272\u540E\u6311\u6218\u7A97\u53E3" }
  },
  clauses: [
    {
      id: "gso-subscribe",
      title: "\u8BA4\u8D2D\uFF1A\u8D44\u91D1\u8FDB\u6258\u7BA1",
      on: { id: "t-sub", kind: "manual", action: "subscribe", enabledStates: ["signing"] },
      when: 'now >= params.openAt && now <= params.closeAt && sumUser(state.contributions, event.userId, "amount") + event.amount <= params.perUserCap && (params.hardCap == null || state.totalRaised + event.amount <= params.hardCap)',
      then: [
        {
          type: "walletTransfer",
          toUserId: "escrow",
          fromUserId: "expr: event.userId",
          currency: "expr: params.currency",
          amount: "expr: event.amount",
          reason: "GSO \u8BA4\u8D2D\u8D44\u91D1\u6258\u7BA1"
        }
      ],
      updates: [
        { field: "totalRaised", op: "add", value: "expr: event.amount" },
        { field: "contributions", op: "push", value: 0, userIdExpr: "event.userId", amountExpr: "event.amount" }
      ]
    },
    {
      id: "gso-reach-softcap",
      title: "\u8FBE\u5230 softCap\uFF08\u516C\u793A\uFF0C\u4E0D\u7ACB\u5373\u4EA4\u5272\uFF09",
      on: { id: "t-softcap", kind: "manual", action: "subscribe", enabledStates: ["signing"] },
      // +1 约定：同触发内 updates 未应用，用 event.amount 预演本次认购
      when: "state.totalRaised + event.amount >= params.softCap",
      then: [{ type: "notify", message: 'expr: "\u5DF2\u8FBE\u6210\u7B79\u76EE\u6807 " + state.totalRaised + " / " + params.softCap', reason: "\u8FBE\u6807\u516C\u793A" }]
    },
    {
      id: "gso-settle",
      title: "\u622A\u6B62\u8FBE\u6807\uFF1A\u4EA4\u5272 + \u94F8 RSV + \u6388\u6CBB\u7406\u6743",
      on: { id: "t-settle", kind: "cron", schedule: "deadline-check", enabledStates: ["signing"] },
      when: "now > params.closeAt && state.totalRaised >= params.softCap",
      then: [
        {
          type: "walletTransfer",
          toUserId: "expr: params.issuerId",
          currency: "expr: params.currency",
          amount: "expr: state.totalRaised",
          reason: "GSO \u52DF\u8D44\u4EA4\u5272"
        },
        {
          type: "mintShareVouchers",
          currency: "expr: params.currency",
          table: { kind: "byField", stateField: "contributions", amountField: "amount" },
          lockupMs: "expr: params.lockupMs",
          reason: "\u94F8\u6536\u76CA\u5206\u6210\u51ED\u8BC1\uFF08RSV\uFF09"
        },
        {
          type: "grantGovernanceWeight",
          gameId: "expr: params.gameId",
          toUserId: "expr: params.issuerId",
          topic: "ALL",
          weightBps: "expr: 10000 - params.governanceShareBps",
          reason: "\u53D1\u884C\u65B9\u4FDD\u7559\u6CBB\u7406\u6743"
        },
        { type: "setState", to: "active", reason: "\u4EA4\u5272\u5B8C\u6210\uFF0C\u6536\u76CA\u5206\u6210\u751F\u6548" }
      ]
    },
    {
      id: "gso-refund",
      title: "\u622A\u6B62\u672A\u8FBE\u6807\uFF1A\u5168\u989D\u81EA\u52A8\u9000\u6B3E",
      on: { id: "t-refund", kind: "cron", schedule: "deadline-check", enabledStates: ["signing"] },
      when: "now > params.closeAt && state.totalRaised < params.softCap",
      then: [{ type: "refundAll", reason: "\u672A\u8FBE softCap \u5168\u989D\u81EA\u52A8\u9000\u6B3E" }, { type: "setState", to: "refunded", reason: "\u52DF\u8D44\u5931\u8D25" }]
    },
    {
      id: "gso-revenue-weekly",
      title: "\u5468\u5EA6\u6536\u76CA\u5206\u6210\uFF08tick \u6CE8\u5165 revenue_ledger \u53E3\u5F84\uFF09",
      description: "event.periodRevenue \u7531\u670D\u52A1\u7AEF\u4ECE\u6536\u76CA\u53F0\u8D26\u67E5\u8BE2\u6CE8\u5165\uFF0C\u5408\u7EA6\u6309 RSV \u4EFD\u989D\u5206\u8D26\uFF1B\u4EC5 settlementCron=weekly \u751F\u6548\u3002",
      on: { id: "t-revenue-w", kind: "cron", schedule: "settlement-weekly", enabledStates: ["active"] },
      when: 'event.periodRevenue > 0 && params.settlementCron == "weekly"',
      then: [
        {
          type: "splitPayout",
          currency: "expr: params.currency",
          table: {
            kind: "byField",
            stateField: "contributions",
            amountField: "amount",
            mode: "share",
            poolAmount: "expr: event.periodRevenue * params.revenueShareBps / 10000"
          },
          reason: "GSO \u5468\u5EA6\u6536\u76CA\u5206\u6210",
          source: "treasury"
        }
      ]
    },
    {
      id: "gso-revenue-monthly",
      title: "\u6708\u5EA6\u6536\u76CA\u5206\u6210\uFF08tick \u6CE8\u5165 revenue_ledger \u53E3\u5F84\uFF09",
      on: { id: "t-revenue-m", kind: "cron", schedule: "settlement-monthly", enabledStates: ["active"] },
      when: 'event.periodRevenue > 0 && params.settlementCron == "monthly"',
      then: [
        {
          type: "splitPayout",
          currency: "expr: params.currency",
          table: {
            kind: "byField",
            stateField: "contributions",
            amountField: "amount",
            mode: "share",
            poolAmount: "expr: event.periodRevenue * params.revenueShareBps / 10000"
          },
          reason: "GSO \u6708\u5EA6\u6536\u76CA\u5206\u6210",
          source: "treasury"
        }
      ]
    },
    {
      id: "gso-game-delisted",
      title: "\u9000\u573A\u6761\u6B3E\uFF1A\u6E38\u620F\u4E0B\u67B6/\u505C\u8FD0",
      description: "\u6258\u7BA1\u4F59\u989D\uFF08\u5982\u6709\uFF09\u6309\u4EFD\u989D\u9000\u8FD8\uFF1B\u5DF2\u4EA4\u5272\u6536\u76CA\u4E0D\u8FFD\u56DE\uFF1BRSV \u7EC8\u6B62\u5206\u8D26\u3002",
      on: { id: "t-delist", kind: "manual", action: "game-delisted", enabledStates: ["signing", "active", "settling"] },
      when: "true",
      then: [
        { type: "refundAll", reason: "\u6E38\u620F\u4E0B\u67B6\uFF0C\u6258\u7BA1\u4F59\u989D\u6309\u8BA4\u8D2D\u6BD4\u4F8B\u9000\u8FD8" },
        { type: "setState", to: "terminated", reason: "\u6807\u7684\u6E38\u620F\u4E0B\u67B6\uFF0C\u5408\u7EA6\u7EC8\u6B62" }
      ]
    },
    {
      id: "gso-dispute",
      title: "\u53D1\u8D77\u6311\u6218",
      on: { id: "t-dispute", kind: "manual", action: "dispute", enabledStates: ["active", "settling"] },
      when: "true",
      then: [
        { type: "openDispute", byUserId: "expr: event.userId", reason: "expr: event.reason" },
        { type: "setState", to: "disputed", reason: 'expr: "\u6311\u6218\u4EBA:" + event.userId' }
      ]
    }
  ]
};

// src/contracts/templates/index.ts
var GROUP_BUY = GROUP_BUY_TEMPLATE;
var TEAM_QUEST = TEAM_QUEST_TEMPLATE;
var GSO = GSO_TEMPLATE;
var REGISTRY = /* @__PURE__ */ new Map();
function registerTemplate(tpl) {
  REGISTRY.set(`${tpl.key}@${tpl.version}`, tpl);
  const cur = REGISTRY.get(tpl.key);
  if (!cur || cur.version < tpl.version) REGISTRY.set(tpl.key, tpl);
}
[GROUP_BUY_TEMPLATE, TEAM_QUEST_TEMPLATE, GSO_TEMPLATE].forEach(registerTemplate);
function getTemplate(key, version) {
  if (version !== void 0) return REGISTRY.get(`${key}@${version}`);
  return REGISTRY.get(String(key));
}
function listTemplates() {
  const seen = /* @__PURE__ */ new Map();
  for (const [k, tpl] of REGISTRY) {
    if (!k.includes("@")) seen.set(k, tpl);
  }
  return [...seen.values()];
}

// src/contracts/acr/acrLinter.ts
var ACR_SPEC_VERSION = "ACR-1/2/3";
var UGC_KEY_RE = /^ugc_[a-z0-9][a-z0-9_-]{2,60}$/;
var RESERVED_TEMPLATE_KEYS = ["gso", "team-quest", "group-buy"];
var UGC_MAX_CLAUSES = 50;
var UGC_MAX_EFFECTS_PER_CLAUSE = 12;
var UGC_MAX_FIELD_DEPTH = 3;
var UGC_MAX_SERIALIZED_BYTES = 256 * 1024;
var UGC_FORBIDDEN_EFFECTS = [
  "mintVoucher",
  // 凭证铸造 = 平台货币主权
  "mintShareVouchers",
  // GSO 专用
  "grantGovernanceWeight",
  // 治理权重 = 平台主权
  "treasuryDeposit"
  // 直接入平台金库（走 market 佣金路径）
];
var CONTROLLED_EFFECTS = ["penalize"];
var ALLOWED_SCHEDULES = ["deadline-check", "tick-5m"];
var RESERVED_ACTIONS = ["__protocol", "deploy", "sign", "invoke", "tick", "query", "detail", "verify", "escrow"];
var LOW_RISK_EFFECTS = ["setState", "notify", "openDispute"];
function isExpr(v) {
  return typeof v === "string" && v.startsWith("expr:");
}
function exprBody(v) {
  return v.slice(5).trim();
}
function exprFirstSegment(body) {
  return body.split(".")[0].trim();
}
function fieldDepth(field) {
  return field.split(".").length;
}
function declaredStringParams(tpl) {
  const out = /* @__PURE__ */ new Set();
  for (const [k, rule] of Object.entries(tpl.paramsSchema || {})) {
    if (rule?.type === "string" || rule?.type === "enum") out.add(k);
  }
  return out;
}
function checkOutgoingRecipient(spec, tpl, path, issues) {
  const toUserId = spec.toUserId;
  if (toUserId === void 0 || toUserId === "escrow") return;
  if (typeof toUserId === "string" && isExpr(toUserId)) {
    const body = exprBody(toUserId);
    if (body === "event.userId") return;
    if (exprFirstSegment(body) === "params") {
      const paramName = body.split(".")[1]?.trim();
      if (paramName && declaredStringParams(tpl).has(paramName)) return;
      issues.push({
        path,
        message: `\u51FA\u8D26\u6536\u6B3E\u65B9\u8868\u8FBE\u5F0F "${toUserId}" \u5F15\u7528\u7684\u53C2\u6570\u672A\u5728 paramsSchema \u4E2D\u4EE5 string/enum \u58F0\u660E\uFF08ACR-2\uFF09`
      });
      return;
    }
    issues.push({ path, message: `\u51FA\u8D26\u6536\u6B3E\u65B9\u8868\u8FBE\u5F0F "${toUserId}" \u975E\u6CD5\uFF1A\u53EA\u5141\u8BB8 event.userId \u6216 params.<\u58F0\u660E\u5B57\u6BB5>\uFF08ACR-2\uFF09` });
    return;
  }
  issues.push({
    path,
    message: `\u51FA\u8D26\u6536\u6B3E\u65B9\u4E0D\u5F97\u786C\u7F16\u7801\uFF08\u5B9E\u9645 ${JSON.stringify(toUserId)}\uFF09\uFF1A\u53EA\u80FD\u7528 'expr: event.userId' \u6216 'expr: params.<\u58F0\u660E\u5B57\u6BB5>'\uFF08ACR-2 \u8D44\u91D1\u5B88\u6052\uFF09`
  });
}
function checkEscrowInSource(spec, tpl, path, issues) {
  if (spec.fromUserId === void 0) return;
  if (typeof spec.fromUserId === "string" && isExpr(spec.fromUserId)) {
    const body = exprBody(spec.fromUserId);
    if (body === "event.userId") return;
    if (exprFirstSegment(body) === "params") {
      const paramName = body.split(".")[1]?.trim();
      if (paramName && declaredStringParams(tpl).has(paramName)) return;
    }
  }
  issues.push({
    path,
    message: `\u5165\u6258\u7BA1\u51FA\u8D44\u65B9 "${String(spec.fromUserId)}" \u975E\u6CD5\uFF1A\u53EA\u80FD\u6263\u4E8B\u4EF6\u5F53\u4E8B\u4EBA\uFF08event.userId\uFF09\u6216 params \u58F0\u660E\u5B57\u6BB5\u7684\u94B1\uFF08ACR-2 \u9632\u5077\u8F6C\u4ED6\u4EBA\u8D44\u91D1\uFF09`
  });
}
function clauseHasEscrowIn(clause) {
  return (clause.then || []).some(
    (e) => e.type === "walletTransfer" && (e.toUserId === "escrow" || e.toUserId === "expr: escrow")
  );
}
function clauseHasRelease(clause) {
  return (clause.then || []).some((e) => {
    if (e.type === "refundAll") return true;
    if (e.type === "penalize") return true;
    if (e.type === "walletTransfer") return e.toUserId !== "escrow";
    if (e.type === "splitPayout") return e.source !== "treasury";
    return false;
  });
}
function lintUgcTemplate(tpl) {
  const issues = [];
  const wl = tpl.effectsWhitelist || [];
  if (typeof tpl.key !== "string" || !UGC_KEY_RE.test(tpl.key)) {
    issues.push({ path: "key", message: `UGC \u6A21\u677F key \u5FC5\u987B\u5339\u914D ${UGC_KEY_RE}\uFF08\u547D\u540D\u7A7A\u95F4\u9694\u79BB\uFF09` });
  }
  if (RESERVED_TEMPLATE_KEYS.includes(String(tpl.key))) {
    issues.push({ path: "key", message: `key "${String(tpl.key)}" \u662F\u5B98\u65B9\u6A21\u677F\u4FDD\u7559\u952E` });
  }
  const clauses = Array.isArray(tpl.clauses) ? tpl.clauses : [];
  if (clauses.length > UGC_MAX_CLAUSES) {
    issues.push({ path: "clauses", message: `\u6761\u6B3E\u6570 ${clauses.length} \u8D85\u8FC7\u4E0A\u9650 ${UGC_MAX_CLAUSES}` });
  }
  try {
    const size = JSON.stringify(tpl).length;
    if (size > UGC_MAX_SERIALIZED_BYTES) {
      issues.push({ path: "clauses", message: `\u6A21\u677F\u5E8F\u5217\u5316\u4F53\u79EF ${size}B \u8D85\u8FC7\u4E0A\u9650 ${UGC_MAX_SERIALIZED_BYTES}B` });
    }
  } catch {
    issues.push({ path: "clauses", message: "\u6A21\u677F\u5305\u542B\u4E0D\u53EF\u5E8F\u5217\u5316\u5185\u5BB9" });
  }
  for (const [i, e] of wl.entries()) {
    if (UGC_FORBIDDEN_EFFECTS.includes(e)) {
      issues.push({ path: `effectsWhitelist[${i}]`, message: `Effect "${e}" \u4E3A\u5E73\u53F0\u7279\u6743\uFF0CUGC \u6A21\u677F\u7981\u7528\uFF08ACR-3\uFF09` });
    }
  }
  let hasEscrowIn = false;
  let hasAnyRelease = false;
  clauses.forEach((clause, ci) => {
    const cPath = `clauses[${ci}](${clause?.id || "?"})`;
    const on = clause?.on;
    if (on?.kind === "cron" && !ALLOWED_SCHEDULES.includes(String(on.schedule))) {
      issues.push({
        path: `${cPath}.on.schedule`,
        message: `cron \u8C03\u5EA6 "${String(on.schedule)}" \u4E0D\u5728 UGC \u767D\u540D\u5355 [${ALLOWED_SCHEDULES.join(" / ")}]\uFF08settlement-* \u4E3A GSO \u5E73\u53F0\u7279\u6743\uFF09`
      });
    }
    if (on?.kind === "manual" && RESERVED_ACTIONS.includes(String(on.action))) {
      issues.push({ path: `${cPath}.on.action`, message: `manual \u52A8\u4F5C\u540D "${String(on.action)}" \u4E3A\u96A7\u9053\u4FDD\u7559\u5B57` });
    }
    (clause?.updates || []).forEach((u, ui) => {
      if (fieldDepth(String(u.field || "")) > UGC_MAX_FIELD_DEPTH) {
        issues.push({ path: `${cPath}.updates[${ui}].field`, message: `\u5B57\u6BB5\u8DEF\u5F84 "${u.field}" \u6DF1\u5EA6\u8D85\u8FC7 ${UGC_MAX_FIELD_DEPTH}\uFF08\u9632\u72B6\u6001\u81A8\u80C0\uFF09` });
      }
      if (u.op === "push") {
      }
    });
    const then = Array.isArray(clause?.then) ? clause.then : [];
    if (then.length > UGC_MAX_EFFECTS_PER_CLAUSE) {
      issues.push({ path: `${cPath}.then`, message: `\u5355\u6761\u6B3E Effect \u6570 ${then.length} \u8D85\u8FC7\u4E0A\u9650 ${UGC_MAX_EFFECTS_PER_CLAUSE}` });
    }
    const escIn = clauseHasEscrowIn(clause);
    const rel = clauseHasRelease(clause);
    if (escIn) hasEscrowIn = true;
    if (rel) hasAnyRelease = true;
    then.forEach((spec, ei) => {
      const ePath = `${cPath}.then[${ei}]`;
      if (!spec || typeof spec !== "object") return;
      if (spec.type === "penalize") {
        if (!CONTROLLED_EFFECTS.includes("penalize")) return;
        if (spec.userId !== "expr: event.userId") {
          issues.push({
            path: `${ePath}.userId`,
            message: `penalize \u53EA\u5141\u8BB8\u9488\u5BF9\u4E8B\u4EF6\u5F53\u4E8B\u4EBA\u672C\u4EBA\uFF08'expr: event.userId'\uFF09\uFF0C\u5B9E\u9645 ${JSON.stringify(spec.userId)}\uFF08ACR-2 \u9632\u7F5A\u6CA1\u4ED6\u4EBA\u8D44\u4EA7\uFF09`
          });
        }
        if (!tpl.requiresAudit) {
          issues.push({ path: "requiresAudit", message: "\u542B penalize \u7684\u6A21\u677F\u5FC5\u987B requiresAudit=true\uFF08\u4EBA\u5DE5\u5BA1\u6838\uFF09" });
        }
      }
      if (spec.type === "walletTransfer") {
        if (spec.fromUserId === void 0 || spec.fromUserId === "escrow") {
          checkOutgoingRecipient(spec, tpl, `${ePath}.toUserId`, issues);
        } else {
          checkEscrowInSource(spec, tpl, `${ePath}.fromUserId`, issues);
        }
      }
      if (spec.type === "splitPayout" && spec.source === "treasury") {
        issues.push({ path: `${ePath}.source`, message: "splitPayout source='treasury'\uFF08\u5E73\u53F0\u91D1\u5E93\u652F\u4ED8\uFF09\u4E3A GSO \u5E73\u53F0\u7279\u6743\uFF0CUGC \u7981\u7528" });
      }
      if (spec.type === "splitPayout" && spec.table && spec.table.kind === "literal") {
        issues.push({
          path: `${ePath}.table`,
          message: "splitPayout literal \u5206\u8D26\u8868\u7981\u6B62\uFF08\u53EF\u786C\u7F16\u7801\u6536\u6B3E\u4EBA\uFF0CACR-2 \u8D44\u91D1\u5B88\u6052\uFF09\uFF1AUGC \u53EA\u5141\u8BB8 table.kind='byField'\uFF08\u6309\u8D21\u732E\u8BB0\u5F55\u5206\u8D26\uFF09"
        });
      }
      if (spec.type === "transferVoucher") {
        checkOutgoingRecipient(spec, tpl, `${ePath}.toUserId`, issues);
      }
    });
  });
  if (hasEscrowIn && !hasAnyRelease) {
    issues.push({
      path: "clauses",
      message: "\u8D44\u91D1\u53EF\u8FDB\u6258\u7BA1\u4F46\u65E0\u4EFB\u4F55\u51FA\u53E3\u6761\u6B3E\uFF08refundAll / \u51FA\u8D26 walletTransfer / splitPayout / penalize\uFF09\u2014\u2014ACR-2 \u8981\u6C42\u5B58\u5728\u53EF\u8FBE\u7684\u9000\u6B3E\u8DEF\u5F84"
    });
  }
  if (["fulfilled", "refunded", "terminated"].includes(String(tpl.initialState))) {
    issues.push({ path: "initialState", message: "initialState \u4E0D\u5F97\u4E3A\u7EC8\u5C40\u72B6\u6001\uFF08fulfilled/refunded/terminated\uFF09" });
  }
  return issues;
}
function classifyTemplateRisk(tpl) {
  const wl = new Set(tpl.effectsWhitelist || []);
  const reasons = [];
  if (wl.has("penalize")) reasons.push("\u542B\u7F5A\u6CA1\uFF08penalize\uFF09");
  if (wl.has("freezeVoucher") || wl.has("unfreezeVoucher")) reasons.push("\u542B\u51ED\u8BC1\u51BB\u7ED3/\u89E3\u51BB");
  if (wl.has("transferVoucher")) reasons.push("\u542B\u51ED\u8BC1\u8F6C\u79FB");
  if (tpl.family === "community_revenue") reasons.push("family=community_revenue\uFF08\u6536\u76CA\u6743\u5C5E\uFF09");
  if (tpl.requiresAudit) reasons.push("\u6A21\u677F\u81EA\u58F0\u660E requiresAudit");
  if (reasons.length > 0) return { level: "high", reasons };
  const funds = ["walletTransfer", "splitPayout", "refundAll"].some((e) => wl.has(e));
  if (funds) return { level: "medium", reasons: ["\u6D89\u8D44\u91D1\u6D41\u8F6C\uFF08\u6258\u7BA1/\u9000\u6B3E/\u5206\u8D26\uFF09"] };
  return { level: "low", reasons: [] };
}
function deriveInitialStateData(tpl) {
  const seed = {
    memberCount: 0,
    totalRaised: 0,
    score: 0,
    poolFunded: 0,
    contributions: []
  };
  for (const clause of Array.isArray(tpl?.clauses) ? tpl.clauses : []) {
    for (const u of clause?.updates || []) {
      if (!u?.field) continue;
      const segs = String(u.field).split(".");
      if (segs.length !== 1) continue;
      if (u.op === "push") {
        if (!Array.isArray(seed[segs[0]])) seed[segs[0]] = [];
      } else if (u.op === "add") {
        if (typeof seed[segs[0]] !== "number") seed[segs[0]] = 0;
      } else if (u.op === "set" && !(segs[0] in seed)) {
        seed[segs[0]] = null;
      }
    }
  }
  return seed;
}
function validateUgcTemplate(tpl) {
  const structural = validateTemplate(tpl);
  const issues = [...structural.issues, ...lintUgcTemplate(tpl)];
  return { ok: issues.length === 0, issues };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ACR_SPEC_VERSION,
  ALL_STATES,
  CONTRACTS_ENABLED,
  CONTRACT_AUTO_EXECUTE,
  CONTRACT_SHADOW_COMPARE,
  GENESIS_HASH,
  GROUP_BUY,
  GSO,
  LOW_RISK_EFFECTS,
  PLATFORM_RULE_DEFAULTS,
  RESERVED_TEMPLATE_KEYS,
  STATE_TRANSITIONS,
  TEAM_QUEST,
  UGC_KEY_RE,
  UGC_MAX_CLAUSES,
  UGC_MAX_EFFECTS_PER_CLAUSE,
  UGC_MAX_FIELD_DEPTH,
  UGC_MAX_SERIALIZED_BYTES,
  appendEvent,
  applyUpdates,
  canonicalize,
  classifyTemplateRisk,
  computeCodeHash,
  computeEventHash,
  deriveInitialStateData,
  evalNumber,
  evalString,
  evaluateExpression,
  executeTrigger,
  getTemplate,
  isContractState,
  isValidTransition,
  lintExpression,
  lintUgcTemplate,
  listTemplates,
  merkleRoot,
  registerTemplate,
  sha256hex,
  triggerMatches,
  validateClauses,
  validateEffectSpec,
  validateParams,
  validateTemplate,
  validateUgcTemplate,
  verifyChain,
  verifyCodeHash
});
