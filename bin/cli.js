#!/usr/bin/env node
import { promisify, formatWithOptions } from 'util';
import g, { stdin, stdout } from 'process';
import f from 'readline';
import * as tty from 'tty';
import { WriteStream } from 'tty';
import { join, sep, resolve, dirname, relative, extname, basename } from 'path';
import { readFile, mkdir, writeFile, rename, unlink, readdir, access, stat, copyFile, lstat } from 'fs/promises';
import { parse } from 'yaml';
import { randomUUID, createHash } from 'crypto';
import { execFile, spawn } from 'child_process';
import { basename as basename$1, extname as extname$1 } from 'path/posix';
import { fileURLToPath } from 'url';

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  __defProp(target, "default", { value: mod, enumerable: true }) ,
  mod
));

// node_modules/picocolors/picocolors.js
var require_picocolors = __commonJS({
  "node_modules/picocolors/picocolors.js"(exports, module) {
    var p = process || {};
    var argv2 = p.argv || [];
    var env2 = p.env || {};
    var isColorSupported2 = !(!!env2.NO_COLOR || argv2.includes("--no-color")) && (!!env2.FORCE_COLOR || argv2.includes("--color") || p.platform === "win32" || (p.stdout || {}).isTTY && env2.TERM !== "dumb" || !!env2.CI);
    var formatter = (open, close, replace = open) => (input) => {
      let string = "" + input, index = string.indexOf(close, open.length);
      return ~index ? open + replaceClose2(string, close, replace, index) + close : open + string + close;
    };
    var replaceClose2 = (string, close, replace, index) => {
      let result = "", cursor = 0;
      do {
        result += string.substring(cursor, index) + replace;
        cursor = index + close.length;
        index = string.indexOf(close, cursor);
      } while (~index);
      return result + string.substring(cursor);
    };
    var createColors2 = (enabled = isColorSupported2) => {
      let f3 = enabled ? formatter : () => String;
      return {
        isColorSupported: enabled,
        reset: f3("\x1B[0m", "\x1B[0m"),
        bold: f3("\x1B[1m", "\x1B[22m", "\x1B[22m\x1B[1m"),
        dim: f3("\x1B[2m", "\x1B[22m", "\x1B[22m\x1B[2m"),
        italic: f3("\x1B[3m", "\x1B[23m"),
        underline: f3("\x1B[4m", "\x1B[24m"),
        inverse: f3("\x1B[7m", "\x1B[27m"),
        hidden: f3("\x1B[8m", "\x1B[28m"),
        strikethrough: f3("\x1B[9m", "\x1B[29m"),
        black: f3("\x1B[30m", "\x1B[39m"),
        red: f3("\x1B[31m", "\x1B[39m"),
        green: f3("\x1B[32m", "\x1B[39m"),
        yellow: f3("\x1B[33m", "\x1B[39m"),
        blue: f3("\x1B[34m", "\x1B[39m"),
        magenta: f3("\x1B[35m", "\x1B[39m"),
        cyan: f3("\x1B[36m", "\x1B[39m"),
        white: f3("\x1B[37m", "\x1B[39m"),
        gray: f3("\x1B[90m", "\x1B[39m"),
        bgBlack: f3("\x1B[40m", "\x1B[49m"),
        bgRed: f3("\x1B[41m", "\x1B[49m"),
        bgGreen: f3("\x1B[42m", "\x1B[49m"),
        bgYellow: f3("\x1B[43m", "\x1B[49m"),
        bgBlue: f3("\x1B[44m", "\x1B[49m"),
        bgMagenta: f3("\x1B[45m", "\x1B[49m"),
        bgCyan: f3("\x1B[46m", "\x1B[49m"),
        bgWhite: f3("\x1B[47m", "\x1B[49m"),
        blackBright: f3("\x1B[90m", "\x1B[39m"),
        redBright: f3("\x1B[91m", "\x1B[39m"),
        greenBright: f3("\x1B[92m", "\x1B[39m"),
        yellowBright: f3("\x1B[93m", "\x1B[39m"),
        blueBright: f3("\x1B[94m", "\x1B[39m"),
        magentaBright: f3("\x1B[95m", "\x1B[39m"),
        cyanBright: f3("\x1B[96m", "\x1B[39m"),
        whiteBright: f3("\x1B[97m", "\x1B[39m"),
        bgBlackBright: f3("\x1B[100m", "\x1B[49m"),
        bgRedBright: f3("\x1B[101m", "\x1B[49m"),
        bgGreenBright: f3("\x1B[102m", "\x1B[49m"),
        bgYellowBright: f3("\x1B[103m", "\x1B[49m"),
        bgBlueBright: f3("\x1B[104m", "\x1B[49m"),
        bgMagentaBright: f3("\x1B[105m", "\x1B[49m"),
        bgCyanBright: f3("\x1B[106m", "\x1B[49m"),
        bgWhiteBright: f3("\x1B[107m", "\x1B[49m")
      };
    };
    module.exports = createColors2();
    module.exports.createColors = createColors2;
  }
});

// node_modules/consola/dist/chunks/prompt.mjs
var prompt_exports = {};
__export(prompt_exports, {
  kCancel: () => kCancel,
  prompt: () => prompt
});
function getDefaultExportFromCjs(x2) {
  return x2 && x2.__esModule && Object.prototype.hasOwnProperty.call(x2, "default") ? x2["default"] : x2;
}
function requireSrc() {
  if (hasRequiredSrc) return src;
  hasRequiredSrc = 1;
  const ESC = "\x1B";
  const CSI = `${ESC}[`;
  const beep = "\x07";
  const cursor = {
    to(x2, y3) {
      if (!y3) return `${CSI}${x2 + 1}G`;
      return `${CSI}${y3 + 1};${x2 + 1}H`;
    },
    move(x2, y3) {
      let ret = "";
      if (x2 < 0) ret += `${CSI}${-x2}D`;
      else if (x2 > 0) ret += `${CSI}${x2}C`;
      if (y3 < 0) ret += `${CSI}${-y3}A`;
      else if (y3 > 0) ret += `${CSI}${y3}B`;
      return ret;
    },
    up: (count = 1) => `${CSI}${count}A`,
    down: (count = 1) => `${CSI}${count}B`,
    forward: (count = 1) => `${CSI}${count}C`,
    backward: (count = 1) => `${CSI}${count}D`,
    nextLine: (count = 1) => `${CSI}E`.repeat(count),
    prevLine: (count = 1) => `${CSI}F`.repeat(count),
    left: `${CSI}G`,
    hide: `${CSI}?25l`,
    show: `${CSI}?25h`,
    save: `${ESC}7`,
    restore: `${ESC}8`
  };
  const scroll = {
    up: (count = 1) => `${CSI}S`.repeat(count),
    down: (count = 1) => `${CSI}T`.repeat(count)
  };
  const erase = {
    screen: `${CSI}2J`,
    up: (count = 1) => `${CSI}1J`.repeat(count),
    down: (count = 1) => `${CSI}J`.repeat(count),
    line: `${CSI}2K`,
    lineEnd: `${CSI}K`,
    lineStart: `${CSI}1K`,
    lines(count) {
      let clear = "";
      for (let i2 = 0; i2 < count; i2++)
        clear += this.line + (i2 < count - 1 ? cursor.up() : "");
      if (count)
        clear += cursor.left;
      return clear;
    }
  };
  src = { cursor, scroll, erase, beep };
  return src;
}
function requirePicocolors() {
  if (hasRequiredPicocolors) return picocolors.exports;
  hasRequiredPicocolors = 1;
  let p = process || {}, argv2 = p.argv || [], env2 = p.env || {};
  let isColorSupported2 = !(!!env2.NO_COLOR || argv2.includes("--no-color")) && (!!env2.FORCE_COLOR || argv2.includes("--color") || p.platform === "win32" || (p.stdout || {}).isTTY && env2.TERM !== "dumb" || !!env2.CI);
  let formatter = (open, close, replace = open) => (input) => {
    let string = "" + input, index = string.indexOf(close, open.length);
    return ~index ? open + replaceClose2(string, close, replace, index) + close : open + string + close;
  };
  let replaceClose2 = (string, close, replace, index) => {
    let result = "", cursor = 0;
    do {
      result += string.substring(cursor, index) + replace;
      cursor = index + close.length;
      index = string.indexOf(close, cursor);
    } while (~index);
    return result + string.substring(cursor);
  };
  let createColors2 = (enabled = isColorSupported2) => {
    let f3 = enabled ? formatter : () => String;
    return {
      isColorSupported: enabled,
      reset: f3("\x1B[0m", "\x1B[0m"),
      bold: f3("\x1B[1m", "\x1B[22m", "\x1B[22m\x1B[1m"),
      dim: f3("\x1B[2m", "\x1B[22m", "\x1B[22m\x1B[2m"),
      italic: f3("\x1B[3m", "\x1B[23m"),
      underline: f3("\x1B[4m", "\x1B[24m"),
      inverse: f3("\x1B[7m", "\x1B[27m"),
      hidden: f3("\x1B[8m", "\x1B[28m"),
      strikethrough: f3("\x1B[9m", "\x1B[29m"),
      black: f3("\x1B[30m", "\x1B[39m"),
      red: f3("\x1B[31m", "\x1B[39m"),
      green: f3("\x1B[32m", "\x1B[39m"),
      yellow: f3("\x1B[33m", "\x1B[39m"),
      blue: f3("\x1B[34m", "\x1B[39m"),
      magenta: f3("\x1B[35m", "\x1B[39m"),
      cyan: f3("\x1B[36m", "\x1B[39m"),
      white: f3("\x1B[37m", "\x1B[39m"),
      gray: f3("\x1B[90m", "\x1B[39m"),
      bgBlack: f3("\x1B[40m", "\x1B[49m"),
      bgRed: f3("\x1B[41m", "\x1B[49m"),
      bgGreen: f3("\x1B[42m", "\x1B[49m"),
      bgYellow: f3("\x1B[43m", "\x1B[49m"),
      bgBlue: f3("\x1B[44m", "\x1B[49m"),
      bgMagenta: f3("\x1B[45m", "\x1B[49m"),
      bgCyan: f3("\x1B[46m", "\x1B[49m"),
      bgWhite: f3("\x1B[47m", "\x1B[49m"),
      blackBright: f3("\x1B[90m", "\x1B[39m"),
      redBright: f3("\x1B[91m", "\x1B[39m"),
      greenBright: f3("\x1B[92m", "\x1B[39m"),
      yellowBright: f3("\x1B[93m", "\x1B[39m"),
      blueBright: f3("\x1B[94m", "\x1B[39m"),
      magentaBright: f3("\x1B[95m", "\x1B[39m"),
      cyanBright: f3("\x1B[96m", "\x1B[39m"),
      whiteBright: f3("\x1B[97m", "\x1B[39m"),
      bgBlackBright: f3("\x1B[100m", "\x1B[49m"),
      bgRedBright: f3("\x1B[101m", "\x1B[49m"),
      bgGreenBright: f3("\x1B[102m", "\x1B[49m"),
      bgYellowBright: f3("\x1B[103m", "\x1B[49m"),
      bgBlueBright: f3("\x1B[104m", "\x1B[49m"),
      bgMagentaBright: f3("\x1B[105m", "\x1B[49m"),
      bgCyanBright: f3("\x1B[106m", "\x1B[49m"),
      bgWhiteBright: f3("\x1B[107m", "\x1B[49m")
    };
  };
  picocolors.exports = createColors2();
  picocolors.exports.createColors = createColors2;
  return picocolors.exports;
}
function J({ onlyFirst: t2 = false } = {}) {
  const F3 = ["[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))", "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"].join("|");
  return new RegExp(F3, t2 ? void 0 : "g");
}
function T$1(t2) {
  if (typeof t2 != "string") throw new TypeError(`Expected a \`string\`, got \`${typeof t2}\``);
  return t2.replace(Q, "");
}
function O(t2) {
  return t2 && t2.__esModule && Object.prototype.hasOwnProperty.call(t2, "default") ? t2.default : t2;
}
function A$1(t2, u3 = {}) {
  if (typeof t2 != "string" || t2.length === 0 || (u3 = { ambiguousIsNarrow: true, ...u3 }, t2 = T$1(t2), t2.length === 0)) return 0;
  t2 = t2.replace(FD(), "  ");
  const F3 = u3.ambiguousIsNarrow ? 1 : 2;
  let e2 = 0;
  for (const s2 of t2) {
    const i2 = s2.codePointAt(0);
    if (i2 <= 31 || i2 >= 127 && i2 <= 159 || i2 >= 768 && i2 <= 879) continue;
    switch (DD.eastAsianWidth(s2)) {
      case "F":
      case "W":
        e2 += 2;
        break;
      case "A":
        e2 += F3;
        break;
      default:
        e2 += 1;
    }
  }
  return e2;
}
function sD() {
  const t2 = /* @__PURE__ */ new Map();
  for (const [u3, F3] of Object.entries(r)) {
    for (const [e2, s2] of Object.entries(F3)) r[e2] = { open: `\x1B[${s2[0]}m`, close: `\x1B[${s2[1]}m` }, F3[e2] = r[e2], t2.set(s2[0], s2[1]);
    Object.defineProperty(r, u3, { value: F3, enumerable: false });
  }
  return Object.defineProperty(r, "codes", { value: t2, enumerable: false }), r.color.close = "\x1B[39m", r.bgColor.close = "\x1B[49m", r.color.ansi = L$1(), r.color.ansi256 = N(), r.color.ansi16m = I(), r.bgColor.ansi = L$1(m), r.bgColor.ansi256 = N(m), r.bgColor.ansi16m = I(m), Object.defineProperties(r, { rgbToAnsi256: { value: (u3, F3, e2) => u3 === F3 && F3 === e2 ? u3 < 8 ? 16 : u3 > 248 ? 231 : Math.round((u3 - 8) / 247 * 24) + 232 : 16 + 36 * Math.round(u3 / 255 * 5) + 6 * Math.round(F3 / 255 * 5) + Math.round(e2 / 255 * 5), enumerable: false }, hexToRgb: { value: (u3) => {
    const F3 = /[a-f\d]{6}|[a-f\d]{3}/i.exec(u3.toString(16));
    if (!F3) return [0, 0, 0];
    let [e2] = F3;
    e2.length === 3 && (e2 = [...e2].map((i2) => i2 + i2).join(""));
    const s2 = Number.parseInt(e2, 16);
    return [s2 >> 16 & 255, s2 >> 8 & 255, s2 & 255];
  }, enumerable: false }, hexToAnsi256: { value: (u3) => r.rgbToAnsi256(...r.hexToRgb(u3)), enumerable: false }, ansi256ToAnsi: { value: (u3) => {
    if (u3 < 8) return 30 + u3;
    if (u3 < 16) return 90 + (u3 - 8);
    let F3, e2, s2;
    if (u3 >= 232) F3 = ((u3 - 232) * 10 + 8) / 255, e2 = F3, s2 = F3;
    else {
      u3 -= 16;
      const C3 = u3 % 36;
      F3 = Math.floor(u3 / 36) / 5, e2 = Math.floor(C3 / 6) / 5, s2 = C3 % 6 / 5;
    }
    const i2 = Math.max(F3, e2, s2) * 2;
    if (i2 === 0) return 30;
    let D2 = 30 + (Math.round(s2) << 2 | Math.round(e2) << 1 | Math.round(F3));
    return i2 === 2 && (D2 += 60), D2;
  }, enumerable: false }, rgbToAnsi: { value: (u3, F3, e2) => r.ansi256ToAnsi(r.rgbToAnsi256(u3, F3, e2)), enumerable: false }, hexToAnsi: { value: (u3) => r.ansi256ToAnsi(r.hexToAnsi256(u3)), enumerable: false } }), r;
}
function G(t2, u3, F3) {
  return String(t2).normalize().replace(/\r\n/g, `
`).split(`
`).map((e2) => oD(e2, u3, F3)).join(`
`);
}
function k$1(t2, u3) {
  if (typeof t2 == "string") return c.aliases.get(t2) === u3;
  for (const F3 of t2) if (F3 !== void 0 && k$1(F3, u3)) return true;
  return false;
}
function lD(t2, u3) {
  if (t2 === u3) return;
  const F3 = t2.split(`
`), e2 = u3.split(`
`), s2 = [];
  for (let i2 = 0; i2 < Math.max(F3.length, e2.length); i2++) F3[i2] !== e2[i2] && s2.push(i2);
  return s2;
}
function d$1(t2, u3) {
  const F3 = t2;
  F3.isTTY && F3.setRawMode(u3);
}
function ce() {
  return g.platform !== "win32" ? g.env.TERM !== "linux" : !!g.env.CI || !!g.env.WT_SESSION || !!g.env.TERMINUS_SUBLIME || g.env.ConEmuTask === "{cmd::Cmder}" || g.env.TERM_PROGRAM === "Terminus-Sublime" || g.env.TERM_PROGRAM === "vscode" || g.env.TERM === "xterm-256color" || g.env.TERM === "alacritty" || g.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
async function prompt(message, opts = {}) {
  const handleCancel = (value) => {
    if (typeof value !== "symbol" || value.toString() !== "Symbol(clack:cancel)") {
      return value;
    }
    switch (opts.cancel) {
      case "reject": {
        const error = new Error("Prompt cancelled.");
        error.name = "ConsolaPromptCancelledError";
        if (Error.captureStackTrace) {
          Error.captureStackTrace(error, prompt);
        }
        throw error;
      }
      case "undefined": {
        return void 0;
      }
      case "null": {
        return null;
      }
      case "symbol": {
        return kCancel;
      }
      default:
      case "default": {
        return opts.default ?? opts.initial;
      }
    }
  };
  if (!opts.type || opts.type === "text") {
    return await he({
      message,
      defaultValue: opts.default,
      placeholder: opts.placeholder,
      initialValue: opts.initial
    }).then(handleCancel);
  }
  if (opts.type === "confirm") {
    return await ye({
      message,
      initialValue: opts.initial
    }).then(handleCancel);
  }
  if (opts.type === "select") {
    return await ve({
      message,
      options: opts.options.map(
        (o3) => typeof o3 === "string" ? { value: o3, label: o3 } : o3
      ),
      initialValue: opts.initial
    }).then(handleCancel);
  }
  if (opts.type === "multiselect") {
    return await fe({
      message,
      options: opts.options.map(
        (o3) => typeof o3 === "string" ? { value: o3, label: o3 } : o3
      ),
      required: opts.required,
      initialValues: opts.initial
    }).then(handleCancel);
  }
  throw new Error(`Unknown prompt type: ${opts.type}`);
}
var src, hasRequiredSrc, srcExports, picocolors, hasRequiredPicocolors, picocolorsExports, e, Q, P$1, X, DD, uD, FD, m, L$1, N, I, r, tD, eD, iD, v, CD, w$1, W$1, rD, R, y, V$1, z, ED, _, nD, oD, aD, c, S, AD, pD, h, x, fD, bD, mD, Y, wD, SD, $D, q, jD, PD, V, u, le, L, W, C, o, d, k, P, A, T, F, w, B, he, ye, ve, fe, kCancel;
var init_prompt = __esm({
  "node_modules/consola/dist/chunks/prompt.mjs"() {
    srcExports = requireSrc();
    picocolors = { exports: {} };
    picocolorsExports = /* @__PURE__ */ requirePicocolors();
    e = /* @__PURE__ */ getDefaultExportFromCjs(picocolorsExports);
    Q = J();
    P$1 = { exports: {} };
    (function(t2) {
      var u3 = {};
      t2.exports = u3, u3.eastAsianWidth = function(e2) {
        var s2 = e2.charCodeAt(0), i2 = e2.length == 2 ? e2.charCodeAt(1) : 0, D2 = s2;
        return 55296 <= s2 && s2 <= 56319 && 56320 <= i2 && i2 <= 57343 && (s2 &= 1023, i2 &= 1023, D2 = s2 << 10 | i2, D2 += 65536), D2 == 12288 || 65281 <= D2 && D2 <= 65376 || 65504 <= D2 && D2 <= 65510 ? "F" : D2 == 8361 || 65377 <= D2 && D2 <= 65470 || 65474 <= D2 && D2 <= 65479 || 65482 <= D2 && D2 <= 65487 || 65490 <= D2 && D2 <= 65495 || 65498 <= D2 && D2 <= 65500 || 65512 <= D2 && D2 <= 65518 ? "H" : 4352 <= D2 && D2 <= 4447 || 4515 <= D2 && D2 <= 4519 || 4602 <= D2 && D2 <= 4607 || 9001 <= D2 && D2 <= 9002 || 11904 <= D2 && D2 <= 11929 || 11931 <= D2 && D2 <= 12019 || 12032 <= D2 && D2 <= 12245 || 12272 <= D2 && D2 <= 12283 || 12289 <= D2 && D2 <= 12350 || 12353 <= D2 && D2 <= 12438 || 12441 <= D2 && D2 <= 12543 || 12549 <= D2 && D2 <= 12589 || 12593 <= D2 && D2 <= 12686 || 12688 <= D2 && D2 <= 12730 || 12736 <= D2 && D2 <= 12771 || 12784 <= D2 && D2 <= 12830 || 12832 <= D2 && D2 <= 12871 || 12880 <= D2 && D2 <= 13054 || 13056 <= D2 && D2 <= 19903 || 19968 <= D2 && D2 <= 42124 || 42128 <= D2 && D2 <= 42182 || 43360 <= D2 && D2 <= 43388 || 44032 <= D2 && D2 <= 55203 || 55216 <= D2 && D2 <= 55238 || 55243 <= D2 && D2 <= 55291 || 63744 <= D2 && D2 <= 64255 || 65040 <= D2 && D2 <= 65049 || 65072 <= D2 && D2 <= 65106 || 65108 <= D2 && D2 <= 65126 || 65128 <= D2 && D2 <= 65131 || 110592 <= D2 && D2 <= 110593 || 127488 <= D2 && D2 <= 127490 || 127504 <= D2 && D2 <= 127546 || 127552 <= D2 && D2 <= 127560 || 127568 <= D2 && D2 <= 127569 || 131072 <= D2 && D2 <= 194367 || 177984 <= D2 && D2 <= 196605 || 196608 <= D2 && D2 <= 262141 ? "W" : 32 <= D2 && D2 <= 126 || 162 <= D2 && D2 <= 163 || 165 <= D2 && D2 <= 166 || D2 == 172 || D2 == 175 || 10214 <= D2 && D2 <= 10221 || 10629 <= D2 && D2 <= 10630 ? "Na" : D2 == 161 || D2 == 164 || 167 <= D2 && D2 <= 168 || D2 == 170 || 173 <= D2 && D2 <= 174 || 176 <= D2 && D2 <= 180 || 182 <= D2 && D2 <= 186 || 188 <= D2 && D2 <= 191 || D2 == 198 || D2 == 208 || 215 <= D2 && D2 <= 216 || 222 <= D2 && D2 <= 225 || D2 == 230 || 232 <= D2 && D2 <= 234 || 236 <= D2 && D2 <= 237 || D2 == 240 || 242 <= D2 && D2 <= 243 || 247 <= D2 && D2 <= 250 || D2 == 252 || D2 == 254 || D2 == 257 || D2 == 273 || D2 == 275 || D2 == 283 || 294 <= D2 && D2 <= 295 || D2 == 299 || 305 <= D2 && D2 <= 307 || D2 == 312 || 319 <= D2 && D2 <= 322 || D2 == 324 || 328 <= D2 && D2 <= 331 || D2 == 333 || 338 <= D2 && D2 <= 339 || 358 <= D2 && D2 <= 359 || D2 == 363 || D2 == 462 || D2 == 464 || D2 == 466 || D2 == 468 || D2 == 470 || D2 == 472 || D2 == 474 || D2 == 476 || D2 == 593 || D2 == 609 || D2 == 708 || D2 == 711 || 713 <= D2 && D2 <= 715 || D2 == 717 || D2 == 720 || 728 <= D2 && D2 <= 731 || D2 == 733 || D2 == 735 || 768 <= D2 && D2 <= 879 || 913 <= D2 && D2 <= 929 || 931 <= D2 && D2 <= 937 || 945 <= D2 && D2 <= 961 || 963 <= D2 && D2 <= 969 || D2 == 1025 || 1040 <= D2 && D2 <= 1103 || D2 == 1105 || D2 == 8208 || 8211 <= D2 && D2 <= 8214 || 8216 <= D2 && D2 <= 8217 || 8220 <= D2 && D2 <= 8221 || 8224 <= D2 && D2 <= 8226 || 8228 <= D2 && D2 <= 8231 || D2 == 8240 || 8242 <= D2 && D2 <= 8243 || D2 == 8245 || D2 == 8251 || D2 == 8254 || D2 == 8308 || D2 == 8319 || 8321 <= D2 && D2 <= 8324 || D2 == 8364 || D2 == 8451 || D2 == 8453 || D2 == 8457 || D2 == 8467 || D2 == 8470 || 8481 <= D2 && D2 <= 8482 || D2 == 8486 || D2 == 8491 || 8531 <= D2 && D2 <= 8532 || 8539 <= D2 && D2 <= 8542 || 8544 <= D2 && D2 <= 8555 || 8560 <= D2 && D2 <= 8569 || D2 == 8585 || 8592 <= D2 && D2 <= 8601 || 8632 <= D2 && D2 <= 8633 || D2 == 8658 || D2 == 8660 || D2 == 8679 || D2 == 8704 || 8706 <= D2 && D2 <= 8707 || 8711 <= D2 && D2 <= 8712 || D2 == 8715 || D2 == 8719 || D2 == 8721 || D2 == 8725 || D2 == 8730 || 8733 <= D2 && D2 <= 8736 || D2 == 8739 || D2 == 8741 || 8743 <= D2 && D2 <= 8748 || D2 == 8750 || 8756 <= D2 && D2 <= 8759 || 8764 <= D2 && D2 <= 8765 || D2 == 8776 || D2 == 8780 || D2 == 8786 || 8800 <= D2 && D2 <= 8801 || 8804 <= D2 && D2 <= 8807 || 8810 <= D2 && D2 <= 8811 || 8814 <= D2 && D2 <= 8815 || 8834 <= D2 && D2 <= 8835 || 8838 <= D2 && D2 <= 8839 || D2 == 8853 || D2 == 8857 || D2 == 8869 || D2 == 8895 || D2 == 8978 || 9312 <= D2 && D2 <= 9449 || 9451 <= D2 && D2 <= 9547 || 9552 <= D2 && D2 <= 9587 || 9600 <= D2 && D2 <= 9615 || 9618 <= D2 && D2 <= 9621 || 9632 <= D2 && D2 <= 9633 || 9635 <= D2 && D2 <= 9641 || 9650 <= D2 && D2 <= 9651 || 9654 <= D2 && D2 <= 9655 || 9660 <= D2 && D2 <= 9661 || 9664 <= D2 && D2 <= 9665 || 9670 <= D2 && D2 <= 9672 || D2 == 9675 || 9678 <= D2 && D2 <= 9681 || 9698 <= D2 && D2 <= 9701 || D2 == 9711 || 9733 <= D2 && D2 <= 9734 || D2 == 9737 || 9742 <= D2 && D2 <= 9743 || 9748 <= D2 && D2 <= 9749 || D2 == 9756 || D2 == 9758 || D2 == 9792 || D2 == 9794 || 9824 <= D2 && D2 <= 9825 || 9827 <= D2 && D2 <= 9829 || 9831 <= D2 && D2 <= 9834 || 9836 <= D2 && D2 <= 9837 || D2 == 9839 || 9886 <= D2 && D2 <= 9887 || 9918 <= D2 && D2 <= 9919 || 9924 <= D2 && D2 <= 9933 || 9935 <= D2 && D2 <= 9953 || D2 == 9955 || 9960 <= D2 && D2 <= 9983 || D2 == 10045 || D2 == 10071 || 10102 <= D2 && D2 <= 10111 || 11093 <= D2 && D2 <= 11097 || 12872 <= D2 && D2 <= 12879 || 57344 <= D2 && D2 <= 63743 || 65024 <= D2 && D2 <= 65039 || D2 == 65533 || 127232 <= D2 && D2 <= 127242 || 127248 <= D2 && D2 <= 127277 || 127280 <= D2 && D2 <= 127337 || 127344 <= D2 && D2 <= 127386 || 917760 <= D2 && D2 <= 917999 || 983040 <= D2 && D2 <= 1048573 || 1048576 <= D2 && D2 <= 1114109 ? "A" : "N";
      }, u3.characterLength = function(e2) {
        var s2 = this.eastAsianWidth(e2);
        return s2 == "F" || s2 == "W" || s2 == "A" ? 2 : 1;
      };
      function F3(e2) {
        return e2.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF]/g) || [];
      }
      u3.length = function(e2) {
        for (var s2 = F3(e2), i2 = 0, D2 = 0; D2 < s2.length; D2++) i2 = i2 + this.characterLength(s2[D2]);
        return i2;
      }, u3.slice = function(e2, s2, i2) {
        textLen = u3.length(e2), s2 = s2 || 0, i2 = i2 || 1, s2 < 0 && (s2 = textLen + s2), i2 < 0 && (i2 = textLen + i2);
        for (var D2 = "", C3 = 0, o3 = F3(e2), E = 0; E < o3.length; E++) {
          var a2 = o3[E], n2 = u3.length(a2);
          if (C3 >= s2 - (n2 == 2 ? 1 : 0)) if (C3 + n2 <= i2) D2 += a2;
          else break;
          C3 += n2;
        }
        return D2;
      };
    })(P$1);
    X = P$1.exports;
    DD = O(X);
    uD = function() {
      return /\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67)\uDB40\uDC7F|(?:\uD83E\uDDD1\uD83C\uDFFF\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFE])|(?:\uD83E\uDDD1\uD83C\uDFFE\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFD\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFC\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFB\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFB\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFC-\uDFFF])|\uD83D\uDC68(?:\uD83C\uDFFB(?:\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF]))|\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFC-\uDFFF])|[\u2695\u2696\u2708]\uFE0F|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))?|(?:\uD83C[\uDFFC-\uDFFF])\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF]))|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83D\uDC68|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFE])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])\uFE0F|\u200D(?:(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D[\uDC66\uDC67])|\uD83D[\uDC66\uDC67])|\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC)?|(?:\uD83D\uDC69(?:\uD83C\uDFFB\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|(?:\uD83C[\uDFFC-\uDFFF])\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69]))|\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1)(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC69(?:\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83E\uDDD1(?:\u200D(?:\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83D\uDC69\u200D\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D[\uDC66\uDC67])|\uD83D\uDC69\u200D\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D\uDC41\uFE0F\u200D\uD83D\uDDE8|\uD83E\uDDD1(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|\uD83D\uDC69(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|\uD83D\uDE36\u200D\uD83C\uDF2B|\uD83C\uDFF3\uFE0F\u200D\u26A7|\uD83D\uDC3B\u200D\u2744|(?:(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF])\u200D[\u2640\u2642]|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|\uD83C\uDFF4\u200D\u2620|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])\u200D[\u2640\u2642]|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u2600-\u2604\u260E\u2611\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26B0\u26B1\u26C8\u26CF\u26D1\u26D3\u26E9\u26F0\u26F1\u26F4\u26F7\u26F8\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u3030\u303D\u3297\u3299]|\uD83C[\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]|\uD83D[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3])\uFE0F|\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08|\uD83D\uDC69\u200D\uD83D\uDC67|\uD83D\uDC69\u200D\uD83D\uDC66|\uD83D\uDE35\u200D\uD83D\uDCAB|\uD83D\uDE2E\u200D\uD83D\uDCA8|\uD83D\uDC15\u200D\uD83E\uDDBA|\uD83E\uDDD1(?:\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC|\uD83C\uDFFB)?|\uD83D\uDC69(?:\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC|\uD83C\uDFFB)?|\uD83C\uDDFD\uD83C\uDDF0|\uD83C\uDDF6\uD83C\uDDE6|\uD83C\uDDF4\uD83C\uDDF2|\uD83D\uDC08\u200D\u2B1B|\u2764\uFE0F\u200D(?:\uD83D\uDD25|\uD83E\uDE79)|\uD83D\uDC41\uFE0F|\uD83C\uDFF3\uFE0F|\uD83C\uDDFF(?:\uD83C[\uDDE6\uDDF2\uDDFC])|\uD83C\uDDFE(?:\uD83C[\uDDEA\uDDF9])|\uD83C\uDDFC(?:\uD83C[\uDDEB\uDDF8])|\uD83C\uDDFB(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA])|\uD83C\uDDFA(?:\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF])|\uD83C\uDDF9(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF])|\uD83C\uDDF8(?:\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF])|\uD83C\uDDF7(?:\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC])|\uD83C\uDDF5(?:\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE])|\uD83C\uDDF3(?:\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF])|\uD83C\uDDF2(?:\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF])|\uD83C\uDDF1(?:\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE])|\uD83C\uDDF0(?:\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF])|\uD83C\uDDEF(?:\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5])|\uD83C\uDDEE(?:\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9])|\uD83C\uDDED(?:\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA])|\uD83C\uDDEC(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE])|\uD83C\uDDEB(?:\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7])|\uD83C\uDDEA(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA])|\uD83C\uDDE9(?:\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF])|\uD83C\uDDE8(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF])|\uD83C\uDDE7(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF])|\uD83C\uDDE6(?:\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF])|[#\*0-9]\uFE0F\u20E3|\u2764\uFE0F|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])|\uD83C\uDFF4|(?:[\u270A\u270B]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5])(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u261D\u270C\u270D]|\uD83D[\uDD74\uDD90])(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])|[\u270A\u270B]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC08\uDC15\uDC3B\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE2E\uDE35\uDE36\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5]|\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD]|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF]|[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED7\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0D\uDD0E\uDD10-\uDD17\uDD1D\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78\uDD7A-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCB\uDDD0\uDDE0-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6]|(?:[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDED5-\uDED7\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDD78\uDD7A-\uDDCB\uDDCD-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6])|(?:[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26A7\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]|\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5-\uDED7\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDD78\uDD7A-\uDDCB\uDDCD-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6])\uFE0F|(?:[\u261D\u26F9\u270A-\u270D]|\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDC8F\uDC91\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1F\uDD26\uDD30-\uDD39\uDD3C-\uDD3E\uDD77\uDDB5\uDDB6\uDDB8\uDDB9\uDDBB\uDDCD-\uDDCF\uDDD1-\uDDDD])/g;
    };
    FD = O(uD);
    m = 10;
    L$1 = (t2 = 0) => (u3) => `\x1B[${u3 + t2}m`;
    N = (t2 = 0) => (u3) => `\x1B[${38 + t2};5;${u3}m`;
    I = (t2 = 0) => (u3, F3, e2) => `\x1B[${38 + t2};2;${u3};${F3};${e2}m`;
    r = { modifier: { reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], overline: [53, 55], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29] }, color: { black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39], blackBright: [90, 39], gray: [90, 39], grey: [90, 39], redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39], blueBright: [94, 39], magentaBright: [95, 39], cyanBright: [96, 39], whiteBright: [97, 39] }, bgColor: { bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49], bgBlue: [44, 49], bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49], bgBlackBright: [100, 49], bgGray: [100, 49], bgGrey: [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49], bgYellowBright: [103, 49], bgBlueBright: [104, 49], bgMagentaBright: [105, 49], bgCyanBright: [106, 49], bgWhiteBright: [107, 49] } };
    Object.keys(r.modifier);
    tD = Object.keys(r.color);
    eD = Object.keys(r.bgColor);
    [...tD, ...eD];
    iD = sD();
    v = /* @__PURE__ */ new Set(["\x1B", "\x9B"]);
    CD = 39;
    w$1 = "\x07";
    W$1 = "[";
    rD = "]";
    R = "m";
    y = `${rD}8;;`;
    V$1 = (t2) => `${v.values().next().value}${W$1}${t2}${R}`;
    z = (t2) => `${v.values().next().value}${y}${t2}${w$1}`;
    ED = (t2) => t2.split(" ").map((u3) => A$1(u3));
    _ = (t2, u3, F3) => {
      const e2 = [...u3];
      let s2 = false, i2 = false, D2 = A$1(T$1(t2[t2.length - 1]));
      for (const [C3, o3] of e2.entries()) {
        const E = A$1(o3);
        if (D2 + E <= F3 ? t2[t2.length - 1] += o3 : (t2.push(o3), D2 = 0), v.has(o3) && (s2 = true, i2 = e2.slice(C3 + 1).join("").startsWith(y)), s2) {
          i2 ? o3 === w$1 && (s2 = false, i2 = false) : o3 === R && (s2 = false);
          continue;
        }
        D2 += E, D2 === F3 && C3 < e2.length - 1 && (t2.push(""), D2 = 0);
      }
      !D2 && t2[t2.length - 1].length > 0 && t2.length > 1 && (t2[t2.length - 2] += t2.pop());
    };
    nD = (t2) => {
      const u3 = t2.split(" ");
      let F3 = u3.length;
      for (; F3 > 0 && !(A$1(u3[F3 - 1]) > 0); ) F3--;
      return F3 === u3.length ? t2 : u3.slice(0, F3).join(" ") + u3.slice(F3).join("");
    };
    oD = (t2, u3, F3 = {}) => {
      if (F3.trim !== false && t2.trim() === "") return "";
      let e2 = "", s2, i2;
      const D2 = ED(t2);
      let C3 = [""];
      for (const [E, a2] of t2.split(" ").entries()) {
        F3.trim !== false && (C3[C3.length - 1] = C3[C3.length - 1].trimStart());
        let n2 = A$1(C3[C3.length - 1]);
        if (E !== 0 && (n2 >= u3 && (F3.wordWrap === false || F3.trim === false) && (C3.push(""), n2 = 0), (n2 > 0 || F3.trim === false) && (C3[C3.length - 1] += " ", n2++)), F3.hard && D2[E] > u3) {
          const B2 = u3 - n2, p = 1 + Math.floor((D2[E] - B2 - 1) / u3);
          Math.floor((D2[E] - 1) / u3) < p && C3.push(""), _(C3, a2, u3);
          continue;
        }
        if (n2 + D2[E] > u3 && n2 > 0 && D2[E] > 0) {
          if (F3.wordWrap === false && n2 < u3) {
            _(C3, a2, u3);
            continue;
          }
          C3.push("");
        }
        if (n2 + D2[E] > u3 && F3.wordWrap === false) {
          _(C3, a2, u3);
          continue;
        }
        C3[C3.length - 1] += a2;
      }
      F3.trim !== false && (C3 = C3.map((E) => nD(E)));
      const o3 = [...C3.join(`
`)];
      for (const [E, a2] of o3.entries()) {
        if (e2 += a2, v.has(a2)) {
          const { groups: B2 } = new RegExp(`(?:\\${W$1}(?<code>\\d+)m|\\${y}(?<uri>.*)${w$1})`).exec(o3.slice(E).join("")) || { groups: {} };
          if (B2.code !== void 0) {
            const p = Number.parseFloat(B2.code);
            s2 = p === CD ? void 0 : p;
          } else B2.uri !== void 0 && (i2 = B2.uri.length === 0 ? void 0 : B2.uri);
        }
        const n2 = iD.codes.get(Number(s2));
        o3[E + 1] === `
` ? (i2 && (e2 += z("")), s2 && n2 && (e2 += V$1(n2))) : a2 === `
` && (s2 && n2 && (e2 += V$1(s2)), i2 && (e2 += z(i2)));
      }
      return e2;
    };
    aD = ["up", "down", "left", "right", "space", "enter", "cancel"];
    c = { actions: new Set(aD), aliases: /* @__PURE__ */ new Map([["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["", "cancel"], ["escape", "cancel"]]) };
    globalThis.process.platform.startsWith("win");
    S = /* @__PURE__ */ Symbol("clack:cancel");
    AD = Object.defineProperty;
    pD = (t2, u3, F3) => u3 in t2 ? AD(t2, u3, { enumerable: true, configurable: true, writable: true, value: F3 }) : t2[u3] = F3;
    h = (t2, u3, F3) => (pD(t2, typeof u3 != "symbol" ? u3 + "" : u3, F3), F3);
    x = class {
      constructor(u3, F3 = true) {
        h(this, "input"), h(this, "output"), h(this, "_abortSignal"), h(this, "rl"), h(this, "opts"), h(this, "_render"), h(this, "_track", false), h(this, "_prevFrame", ""), h(this, "_subscribers", /* @__PURE__ */ new Map()), h(this, "_cursor", 0), h(this, "state", "initial"), h(this, "error", ""), h(this, "value");
        const { input: e2 = stdin, output: s2 = stdout, render: i2, signal: D2, ...C3 } = u3;
        this.opts = C3, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = i2.bind(this), this._track = F3, this._abortSignal = D2, this.input = e2, this.output = s2;
      }
      unsubscribe() {
        this._subscribers.clear();
      }
      setSubscriber(u3, F3) {
        const e2 = this._subscribers.get(u3) ?? [];
        e2.push(F3), this._subscribers.set(u3, e2);
      }
      on(u3, F3) {
        this.setSubscriber(u3, { cb: F3 });
      }
      once(u3, F3) {
        this.setSubscriber(u3, { cb: F3, once: true });
      }
      emit(u3, ...F3) {
        const e2 = this._subscribers.get(u3) ?? [], s2 = [];
        for (const i2 of e2) i2.cb(...F3), i2.once && s2.push(() => e2.splice(e2.indexOf(i2), 1));
        for (const i2 of s2) i2();
      }
      prompt() {
        return new Promise((u3, F3) => {
          if (this._abortSignal) {
            if (this._abortSignal.aborted) return this.state = "cancel", this.close(), u3(S);
            this._abortSignal.addEventListener("abort", () => {
              this.state = "cancel", this.close();
            }, { once: true });
          }
          const e2 = new WriteStream(0);
          e2._write = (s2, i2, D2) => {
            this._track && (this.value = this.rl?.line.replace(/\t/g, ""), this._cursor = this.rl?.cursor ?? 0, this.emit("value", this.value)), D2();
          }, this.input.pipe(e2), this.rl = f.createInterface({ input: this.input, output: e2, tabSize: 2, prompt: "", escapeCodeTimeout: 50 }), f.emitKeypressEvents(this.input, this.rl), this.rl.prompt(), this.opts.initialValue !== void 0 && this._track && this.rl.write(this.opts.initialValue), this.input.on("keypress", this.onKeypress), d$1(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
            this.output.write(srcExports.cursor.show), this.output.off("resize", this.render), d$1(this.input, false), u3(this.value);
          }), this.once("cancel", () => {
            this.output.write(srcExports.cursor.show), this.output.off("resize", this.render), d$1(this.input, false), u3(S);
          });
        });
      }
      onKeypress(u3, F3) {
        if (this.state === "error" && (this.state = "active"), F3?.name && (!this._track && c.aliases.has(F3.name) && this.emit("cursor", c.aliases.get(F3.name)), c.actions.has(F3.name) && this.emit("cursor", F3.name)), u3 && (u3.toLowerCase() === "y" || u3.toLowerCase() === "n") && this.emit("confirm", u3.toLowerCase() === "y"), u3 === "	" && this.opts.placeholder && (this.value || (this.rl?.write(this.opts.placeholder), this.emit("value", this.opts.placeholder))), u3 && this.emit("key", u3.toLowerCase()), F3?.name === "return") {
          if (this.opts.validate) {
            const e2 = this.opts.validate(this.value);
            e2 && (this.error = e2 instanceof Error ? e2.message : e2, this.state = "error", this.rl?.write(this.value));
          }
          this.state !== "error" && (this.state = "submit");
        }
        k$1([u3, F3?.name, F3?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
      }
      close() {
        this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), d$1(this.input, false), this.rl?.close(), this.rl = void 0, this.emit(`${this.state}`, this.value), this.unsubscribe();
      }
      restoreCursor() {
        const u3 = G(this._prevFrame, process.stdout.columns, { hard: true }).split(`
`).length - 1;
        this.output.write(srcExports.cursor.move(-999, u3 * -1));
      }
      render() {
        const u3 = G(this._render(this) ?? "", process.stdout.columns, { hard: true });
        if (u3 !== this._prevFrame) {
          if (this.state === "initial") this.output.write(srcExports.cursor.hide);
          else {
            const F3 = lD(this._prevFrame, u3);
            if (this.restoreCursor(), F3 && F3?.length === 1) {
              const e2 = F3[0];
              this.output.write(srcExports.cursor.move(0, e2)), this.output.write(srcExports.erase.lines(1));
              const s2 = u3.split(`
`);
              this.output.write(s2[e2]), this._prevFrame = u3, this.output.write(srcExports.cursor.move(0, s2.length - e2 - 1));
              return;
            }
            if (F3 && F3?.length > 1) {
              const e2 = F3[0];
              this.output.write(srcExports.cursor.move(0, e2)), this.output.write(srcExports.erase.down());
              const s2 = u3.split(`
`).slice(e2);
              this.output.write(s2.join(`
`)), this._prevFrame = u3;
              return;
            }
            this.output.write(srcExports.erase.down());
          }
          this.output.write(u3), this.state === "initial" && (this.state = "active"), this._prevFrame = u3;
        }
      }
    };
    fD = class extends x {
      get cursor() {
        return this.value ? 0 : 1;
      }
      get _value() {
        return this.cursor === 0;
      }
      constructor(u3) {
        super(u3, false), this.value = !!u3.initialValue, this.on("value", () => {
          this.value = this._value;
        }), this.on("confirm", (F3) => {
          this.output.write(srcExports.cursor.move(0, -1)), this.value = F3, this.state = "submit", this.close();
        }), this.on("cursor", () => {
          this.value = !this.value;
        });
      }
    };
    bD = Object.defineProperty;
    mD = (t2, u3, F3) => u3 in t2 ? bD(t2, u3, { enumerable: true, configurable: true, writable: true, value: F3 }) : t2[u3] = F3;
    Y = (t2, u3, F3) => (mD(t2, typeof u3 != "symbol" ? u3 + "" : u3, F3), F3);
    wD = class extends x {
      constructor(u3) {
        super(u3, false), Y(this, "options"), Y(this, "cursor", 0), this.options = u3.options, this.value = [...u3.initialValues ?? []], this.cursor = Math.max(this.options.findIndex(({ value: F3 }) => F3 === u3.cursorAt), 0), this.on("key", (F3) => {
          F3 === "a" && this.toggleAll();
        }), this.on("cursor", (F3) => {
          switch (F3) {
            case "left":
            case "up":
              this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
              break;
            case "down":
            case "right":
              this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
              break;
            case "space":
              this.toggleValue();
              break;
          }
        });
      }
      get _value() {
        return this.options[this.cursor].value;
      }
      toggleAll() {
        const u3 = this.value.length === this.options.length;
        this.value = u3 ? [] : this.options.map((F3) => F3.value);
      }
      toggleValue() {
        const u3 = this.value.includes(this._value);
        this.value = u3 ? this.value.filter((F3) => F3 !== this._value) : [...this.value, this._value];
      }
    };
    SD = Object.defineProperty;
    $D = (t2, u3, F3) => u3 in t2 ? SD(t2, u3, { enumerable: true, configurable: true, writable: true, value: F3 }) : t2[u3] = F3;
    q = (t2, u3, F3) => ($D(t2, typeof u3 != "symbol" ? u3 + "" : u3, F3), F3);
    jD = class extends x {
      constructor(u3) {
        super(u3, false), q(this, "options"), q(this, "cursor", 0), this.options = u3.options, this.cursor = this.options.findIndex(({ value: F3 }) => F3 === u3.initialValue), this.cursor === -1 && (this.cursor = 0), this.changeValue(), this.on("cursor", (F3) => {
          switch (F3) {
            case "left":
            case "up":
              this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
              break;
            case "down":
            case "right":
              this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
              break;
          }
          this.changeValue();
        });
      }
      get _value() {
        return this.options[this.cursor];
      }
      changeValue() {
        this.value = this._value.value;
      }
    };
    PD = class extends x {
      get valueWithCursor() {
        if (this.state === "submit") return this.value;
        if (this.cursor >= this.value.length) return `${this.value}\u2588`;
        const u3 = this.value.slice(0, this.cursor), [F3, ...e$1] = this.value.slice(this.cursor);
        return `${u3}${e.inverse(F3)}${e$1.join("")}`;
      }
      get cursor() {
        return this._cursor;
      }
      constructor(u3) {
        super(u3), this.on("finalize", () => {
          this.value || (this.value = u3.defaultValue);
        });
      }
    };
    V = ce();
    u = (t2, n2) => V ? t2 : n2;
    le = u("\u276F", ">");
    L = u("\u25A0", "x");
    W = u("\u25B2", "x");
    C = u("\u2714", "\u221A");
    o = u("");
    d = u("");
    k = u("\u25CF", ">");
    P = u("\u25CB", " ");
    A = u("\u25FB", "[\u2022]");
    T = u("\u25FC", "[+]");
    F = u("\u25FB", "[ ]");
    w = (t2) => {
      switch (t2) {
        case "initial":
        case "active":
          return e.cyan(le);
        case "cancel":
          return e.red(L);
        case "error":
          return e.yellow(W);
        case "submit":
          return e.green(C);
      }
    };
    B = (t2) => {
      const { cursor: n2, options: s2, style: r3 } = t2, i2 = t2.maxItems ?? Number.POSITIVE_INFINITY, a2 = Math.max(process.stdout.rows - 4, 0), c3 = Math.min(a2, Math.max(i2, 5));
      let l2 = 0;
      n2 >= l2 + c3 - 3 ? l2 = Math.max(Math.min(n2 - c3 + 3, s2.length - c3), 0) : n2 < l2 + 2 && (l2 = Math.max(n2 - 2, 0));
      const $ = c3 < s2.length && l2 > 0, p = c3 < s2.length && l2 + c3 < s2.length;
      return s2.slice(l2, l2 + c3).map((M, v2, x2) => {
        const j = v2 === 0 && $, E = v2 === x2.length - 1 && p;
        return j || E ? e.dim("...") : r3(M, v2 + l2 === n2);
      });
    };
    he = (t2) => new PD({ validate: t2.validate, placeholder: t2.placeholder, defaultValue: t2.defaultValue, initialValue: t2.initialValue, render() {
      const n2 = `${e.gray(o)}
${w(this.state)} ${t2.message}
`, s2 = t2.placeholder ? e.inverse(t2.placeholder[0]) + e.dim(t2.placeholder.slice(1)) : e.inverse(e.hidden("_")), r3 = this.value ? this.valueWithCursor : s2;
      switch (this.state) {
        case "error":
          return `${n2.trim()}
${e.yellow(o)} ${r3}
${e.yellow(d)} ${e.yellow(this.error)}
`;
        case "submit":
          return `${n2}${e.gray(o)} ${e.dim(this.value || t2.placeholder)}`;
        case "cancel":
          return `${n2}${e.gray(o)} ${e.strikethrough(e.dim(this.value ?? ""))}${this.value?.trim() ? `
${e.gray(o)}` : ""}`;
        default:
          return `${n2}${e.cyan(o)} ${r3}
${e.cyan(d)}
`;
      }
    } }).prompt();
    ye = (t2) => {
      const n2 = t2.active ?? "Yes", s2 = t2.inactive ?? "No";
      return new fD({ active: n2, inactive: s2, initialValue: t2.initialValue ?? true, render() {
        const r3 = `${e.gray(o)}
${w(this.state)} ${t2.message}
`, i2 = this.value ? n2 : s2;
        switch (this.state) {
          case "submit":
            return `${r3}${e.gray(o)} ${e.dim(i2)}`;
          case "cancel":
            return `${r3}${e.gray(o)} ${e.strikethrough(e.dim(i2))}
${e.gray(o)}`;
          default:
            return `${r3}${e.cyan(o)} ${this.value ? `${e.green(k)} ${n2}` : `${e.dim(P)} ${e.dim(n2)}`} ${e.dim("/")} ${this.value ? `${e.dim(P)} ${e.dim(s2)}` : `${e.green(k)} ${s2}`}
${e.cyan(d)}
`;
        }
      } }).prompt();
    };
    ve = (t2) => {
      const n2 = (s2, r3) => {
        const i2 = s2.label ?? String(s2.value);
        switch (r3) {
          case "selected":
            return `${e.dim(i2)}`;
          case "active":
            return `${e.green(k)} ${i2} ${s2.hint ? e.dim(`(${s2.hint})`) : ""}`;
          case "cancelled":
            return `${e.strikethrough(e.dim(i2))}`;
          default:
            return `${e.dim(P)} ${e.dim(i2)}`;
        }
      };
      return new jD({ options: t2.options, initialValue: t2.initialValue, render() {
        const s2 = `${e.gray(o)}
${w(this.state)} ${t2.message}
`;
        switch (this.state) {
          case "submit":
            return `${s2}${e.gray(o)} ${n2(this.options[this.cursor], "selected")}`;
          case "cancel":
            return `${s2}${e.gray(o)} ${n2(this.options[this.cursor], "cancelled")}
${e.gray(o)}`;
          default:
            return `${s2}${e.cyan(o)} ${B({ cursor: this.cursor, options: this.options, maxItems: t2.maxItems, style: (r3, i2) => n2(r3, i2 ? "active" : "inactive") }).join(`
${e.cyan(o)}  `)}
${e.cyan(d)}
`;
        }
      } }).prompt();
    };
    fe = (t2) => {
      const n2 = (s2, r3) => {
        const i2 = s2.label ?? String(s2.value);
        return r3 === "active" ? `${e.cyan(A)} ${i2} ${s2.hint ? e.dim(`(${s2.hint})`) : ""}` : r3 === "selected" ? `${e.green(T)} ${e.dim(i2)}` : r3 === "cancelled" ? `${e.strikethrough(e.dim(i2))}` : r3 === "active-selected" ? `${e.green(T)} ${i2} ${s2.hint ? e.dim(`(${s2.hint})`) : ""}` : r3 === "submitted" ? `${e.dim(i2)}` : `${e.dim(F)} ${e.dim(i2)}`;
      };
      return new wD({ options: t2.options, initialValues: t2.initialValues, required: t2.required ?? true, cursorAt: t2.cursorAt, validate(s2) {
        if (this.required && s2.length === 0) return `Please select at least one option.
${e.reset(e.dim(`Press ${e.gray(e.bgWhite(e.inverse(" space ")))} to select, ${e.gray(e.bgWhite(e.inverse(" enter ")))} to submit`))}`;
      }, render() {
        const s2 = `${e.gray(o)}
${w(this.state)} ${t2.message}
`, r3 = (i2, a2) => {
          const c3 = this.value.includes(i2.value);
          return a2 && c3 ? n2(i2, "active-selected") : c3 ? n2(i2, "selected") : n2(i2, a2 ? "active" : "inactive");
        };
        switch (this.state) {
          case "submit":
            return `${s2}${e.gray(o)} ${this.options.filter(({ value: i2 }) => this.value.includes(i2)).map((i2) => n2(i2, "submitted")).join(e.dim(", ")) || e.dim("none")}`;
          case "cancel": {
            const i2 = this.options.filter(({ value: a2 }) => this.value.includes(a2)).map((a2) => n2(a2, "cancelled")).join(e.dim(", "));
            return `${s2}${e.gray(o)} ${i2.trim() ? `${i2}
${e.gray(o)}` : ""}`;
          }
          case "error": {
            const i2 = this.error.split(`
`).map((a2, c3) => c3 === 0 ? `${e.yellow(d)} ${e.yellow(a2)}` : `   ${a2}`).join(`
`);
            return `${s2 + e.yellow(o)} ${B({ options: this.options, cursor: this.cursor, maxItems: t2.maxItems, style: r3 }).join(`
${e.yellow(o)}  `)}
${i2}
`;
          }
          default:
            return `${s2}${e.cyan(o)} ${B({ options: this.options, cursor: this.cursor, maxItems: t2.maxItems, style: r3 }).join(`
${e.cyan(o)}  `)}
${e.cyan(d)}
`;
        }
      } }).prompt();
    };
    `${e.gray(o)}  `;
    kCancel = /* @__PURE__ */ Symbol.for("cancel");
  }
});

// src/cli/main.ts
var import_picocolors = __toESM(require_picocolors());

// node_modules/consola/dist/core.mjs
var LogLevels = {
  fatal: 0,
  error: 0,
  warn: 1,
  log: 2,
  info: 3,
  success: 3,
  fail: 3,
  debug: 4,
  trace: 5,
  verbose: Number.POSITIVE_INFINITY
};
var LogTypes = {
  // Silent
  silent: {
    level: -1
  },
  // Level 0
  fatal: {
    level: LogLevels.fatal
  },
  error: {
    level: LogLevels.error
  },
  // Level 1
  warn: {
    level: LogLevels.warn
  },
  // Level 2
  log: {
    level: LogLevels.log
  },
  // Level 3
  info: {
    level: LogLevels.info
  },
  success: {
    level: LogLevels.success
  },
  fail: {
    level: LogLevels.fail
  },
  ready: {
    level: LogLevels.info
  },
  start: {
    level: LogLevels.info
  },
  box: {
    level: LogLevels.info
  },
  // Level 4
  debug: {
    level: LogLevels.debug
  },
  // Level 5
  trace: {
    level: LogLevels.trace
  },
  // Verbose
  verbose: {
    level: LogLevels.verbose
  }
};
function isPlainObject$1(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && Object.getPrototypeOf(prototype) !== null) {
    return false;
  }
  if (Symbol.iterator in value) {
    return false;
  }
  if (Symbol.toStringTag in value) {
    return Object.prototype.toString.call(value) === "[object Module]";
  }
  return true;
}
function _defu(baseObject, defaults, namespace = ".", merger) {
  if (!isPlainObject$1(defaults)) {
    return _defu(baseObject, {}, namespace);
  }
  const object = Object.assign({}, defaults);
  for (const key in baseObject) {
    if (key === "__proto__" || key === "constructor") {
      continue;
    }
    const value = baseObject[key];
    if (value === null || value === void 0) {
      continue;
    }
    if (Array.isArray(value) && Array.isArray(object[key])) {
      object[key] = [...value, ...object[key]];
    } else if (isPlainObject$1(value) && isPlainObject$1(object[key])) {
      object[key] = _defu(
        value,
        object[key],
        (namespace ? `${namespace}.` : "") + key.toString());
    } else {
      object[key] = value;
    }
  }
  return object;
}
function createDefu(merger) {
  return (...arguments_) => (
    // eslint-disable-next-line unicorn/no-array-reduce
    arguments_.reduce((p, c3) => _defu(p, c3, ""), {})
  );
}
var defu = createDefu();
function isPlainObject(obj) {
  return Object.prototype.toString.call(obj) === "[object Object]";
}
function isLogObj(arg) {
  if (!isPlainObject(arg)) {
    return false;
  }
  if (!arg.message && !arg.args) {
    return false;
  }
  if (arg.stack) {
    return false;
  }
  return true;
}
var paused = false;
var queue = [];
var Consola = class _Consola {
  options;
  _lastLog;
  _mockFn;
  /**
   * Creates an instance of Consola with specified options or defaults.
   *
   * @param {Partial<ConsolaOptions>} [options={}] - Configuration options for the Consola instance.
   */
  constructor(options = {}) {
    const types = options.types || LogTypes;
    this.options = defu(
      {
        ...options,
        defaults: { ...options.defaults },
        level: _normalizeLogLevel(options.level, types),
        reporters: [...options.reporters || []]
      },
      {
        types: LogTypes,
        throttle: 1e3,
        throttleMin: 5,
        formatOptions: {
          date: true,
          colors: false,
          compact: true
        }
      }
    );
    for (const type in types) {
      const defaults = {
        type,
        ...this.options.defaults,
        ...types[type]
      };
      this[type] = this._wrapLogFn(defaults);
      this[type].raw = this._wrapLogFn(
        defaults,
        true
      );
    }
    if (this.options.mockFn) {
      this.mockTypes();
    }
    this._lastLog = {};
  }
  /**
   * Gets the current log level of the Consola instance.
   *
   * @returns {number} The current log level.
   */
  get level() {
    return this.options.level;
  }
  /**
   * Sets the minimum log level that will be output by the instance.
   *
   * @param {number} level - The new log level to set.
   */
  set level(level) {
    this.options.level = _normalizeLogLevel(
      level,
      this.options.types,
      this.options.level
    );
  }
  /**
   * Displays a prompt to the user and returns the response.
   * Throw an error if `prompt` is not supported by the current configuration.
   *
   * @template T
   * @param {string} message - The message to display in the prompt.
   * @param {T} [opts] - Optional options for the prompt. See {@link PromptOptions}.
   * @returns {promise<T>} A promise that infer with the prompt options. See {@link PromptOptions}.
   */
  prompt(message, opts) {
    if (!this.options.prompt) {
      throw new Error("prompt is not supported!");
    }
    return this.options.prompt(message, opts);
  }
  /**
   * Creates a new instance of Consola, inheriting options from the current instance, with possible overrides.
   *
   * @param {Partial<ConsolaOptions>} options - Optional overrides for the new instance. See {@link ConsolaOptions}.
   * @returns {ConsolaInstance} A new Consola instance. See {@link ConsolaInstance}.
   */
  create(options) {
    const instance = new _Consola({
      ...this.options,
      ...options
    });
    if (this._mockFn) {
      instance.mockTypes(this._mockFn);
    }
    return instance;
  }
  /**
   * Creates a new Consola instance with the specified default log object properties.
   *
   * @param {InputLogObject} defaults - Default properties to include in any log from the new instance. See {@link InputLogObject}.
   * @returns {ConsolaInstance} A new Consola instance. See {@link ConsolaInstance}.
   */
  withDefaults(defaults) {
    return this.create({
      ...this.options,
      defaults: {
        ...this.options.defaults,
        ...defaults
      }
    });
  }
  /**
   * Creates a new Consola instance with a specified tag, which will be included in every log.
   *
   * @param {string} tag - The tag to include in each log of the new instance.
   * @returns {ConsolaInstance} A new Consola instance. See {@link ConsolaInstance}.
   */
  withTag(tag) {
    return this.withDefaults({
      tag: this.options.defaults.tag ? this.options.defaults.tag + ":" + tag : tag
    });
  }
  /**
   * Adds a custom reporter to the Consola instance.
   * Reporters will be called for each log message, depending on their implementation and log level.
   *
   * @param {ConsolaReporter} reporter - The reporter to add. See {@link ConsolaReporter}.
   * @returns {Consola} The current Consola instance.
   */
  addReporter(reporter) {
    this.options.reporters.push(reporter);
    return this;
  }
  /**
   * Removes a custom reporter from the Consola instance.
   * If no reporter is specified, all reporters will be removed.
   *
   * @param {ConsolaReporter} reporter - The reporter to remove. See {@link ConsolaReporter}.
   * @returns {Consola} The current Consola instance.
   */
  removeReporter(reporter) {
    if (reporter) {
      const i2 = this.options.reporters.indexOf(reporter);
      if (i2 !== -1) {
        return this.options.reporters.splice(i2, 1);
      }
    } else {
      this.options.reporters.splice(0);
    }
    return this;
  }
  /**
   * Replaces all reporters of the Consola instance with the specified array of reporters.
   *
   * @param {ConsolaReporter[]} reporters - The new reporters to set. See {@link ConsolaReporter}.
   * @returns {Consola} The current Consola instance.
   */
  setReporters(reporters) {
    this.options.reporters = Array.isArray(reporters) ? reporters : [reporters];
    return this;
  }
  wrapAll() {
    this.wrapConsole();
    this.wrapStd();
  }
  restoreAll() {
    this.restoreConsole();
    this.restoreStd();
  }
  /**
   * Overrides console methods with Consola logging methods for consistent logging.
   */
  wrapConsole() {
    for (const type in this.options.types) {
      if (!console["__" + type]) {
        console["__" + type] = console[type];
      }
      console[type] = this[type].raw;
    }
  }
  /**
   * Restores the original console methods, removing Consola overrides.
   */
  restoreConsole() {
    for (const type in this.options.types) {
      if (console["__" + type]) {
        console[type] = console["__" + type];
        delete console["__" + type];
      }
    }
  }
  /**
   * Overrides standard output and error streams to redirect them through Consola.
   */
  wrapStd() {
    this._wrapStream(this.options.stdout, "log");
    this._wrapStream(this.options.stderr, "log");
  }
  _wrapStream(stream, type) {
    if (!stream) {
      return;
    }
    if (!stream.__write) {
      stream.__write = stream.write;
    }
    stream.write = (data) => {
      this[type].raw(String(data).trim());
    };
  }
  /**
   * Restores the original standard output and error streams, removing the Consola redirection.
   */
  restoreStd() {
    this._restoreStream(this.options.stdout);
    this._restoreStream(this.options.stderr);
  }
  _restoreStream(stream) {
    if (!stream) {
      return;
    }
    if (stream.__write) {
      stream.write = stream.__write;
      delete stream.__write;
    }
  }
  /**
   * Pauses logging, queues incoming logs until resumed.
   */
  pauseLogs() {
    paused = true;
  }
  /**
   * Resumes logging, processing any queued logs.
   */
  resumeLogs() {
    paused = false;
    const _queue = queue.splice(0);
    for (const item of _queue) {
      item[0]._logFn(item[1], item[2]);
    }
  }
  /**
   * Replaces logging methods with mocks if a mock function is provided.
   *
   * @param {ConsolaOptions["mockFn"]} mockFn - The function to use for mocking logging methods. See {@link ConsolaOptions["mockFn"]}.
   */
  mockTypes(mockFn) {
    const _mockFn = mockFn || this.options.mockFn;
    this._mockFn = _mockFn;
    if (typeof _mockFn !== "function") {
      return;
    }
    for (const type in this.options.types) {
      this[type] = _mockFn(type, this.options.types[type]) || this[type];
      this[type].raw = this[type];
    }
  }
  _wrapLogFn(defaults, isRaw) {
    return (...args) => {
      if (paused) {
        queue.push([this, defaults, args, isRaw]);
        return;
      }
      return this._logFn(defaults, args, isRaw);
    };
  }
  _logFn(defaults, args, isRaw) {
    if ((defaults.level || 0) > this.level) {
      return false;
    }
    const logObj = {
      date: /* @__PURE__ */ new Date(),
      args: [],
      ...defaults,
      level: _normalizeLogLevel(defaults.level, this.options.types)
    };
    if (!isRaw && args.length === 1 && isLogObj(args[0])) {
      Object.assign(logObj, args[0]);
    } else {
      logObj.args = [...args];
    }
    if (logObj.message) {
      logObj.args.unshift(logObj.message);
      delete logObj.message;
    }
    if (logObj.additional) {
      if (!Array.isArray(logObj.additional)) {
        logObj.additional = logObj.additional.split("\n");
      }
      logObj.args.push("\n" + logObj.additional.join("\n"));
      delete logObj.additional;
    }
    logObj.type = typeof logObj.type === "string" ? logObj.type.toLowerCase() : "log";
    logObj.tag = typeof logObj.tag === "string" ? logObj.tag : "";
    const resolveLog = (newLog = false) => {
      const repeated = (this._lastLog.count || 0) - this.options.throttleMin;
      if (this._lastLog.object && repeated > 0) {
        const args2 = [...this._lastLog.object.args];
        if (repeated > 1) {
          args2.push(`(repeated ${repeated} times)`);
        }
        this._log({ ...this._lastLog.object, args: args2 });
        this._lastLog.count = 1;
      }
      if (newLog) {
        this._lastLog.object = logObj;
        this._log(logObj);
      }
    };
    clearTimeout(this._lastLog.timeout);
    const diffTime = this._lastLog.time && logObj.date ? logObj.date.getTime() - this._lastLog.time.getTime() : 0;
    this._lastLog.time = logObj.date;
    if (diffTime < this.options.throttle) {
      try {
        const serializedLog = JSON.stringify([
          logObj.type,
          logObj.tag,
          logObj.args
        ]);
        const isSameLog = this._lastLog.serialized === serializedLog;
        this._lastLog.serialized = serializedLog;
        if (isSameLog) {
          this._lastLog.count = (this._lastLog.count || 0) + 1;
          if (this._lastLog.count > this.options.throttleMin) {
            this._lastLog.timeout = setTimeout(
              resolveLog,
              this.options.throttle
            );
            return;
          }
        }
      } catch {
      }
    }
    resolveLog(true);
  }
  _log(logObj) {
    for (const reporter of this.options.reporters) {
      reporter.log(logObj, {
        options: this.options
      });
    }
  }
};
function _normalizeLogLevel(input, types = {}, defaultLevel = 3) {
  if (input === void 0) {
    return defaultLevel;
  }
  if (typeof input === "number") {
    return input;
  }
  if (types[input] && types[input].level !== void 0) {
    return types[input].level;
  }
  return defaultLevel;
}
Consola.prototype.add = Consola.prototype.addReporter;
Consola.prototype.remove = Consola.prototype.removeReporter;
Consola.prototype.clear = Consola.prototype.removeReporter;
Consola.prototype.withScope = Consola.prototype.withTag;
Consola.prototype.mock = Consola.prototype.mockTypes;
Consola.prototype.pause = Consola.prototype.pauseLogs;
Consola.prototype.resume = Consola.prototype.resumeLogs;
function createConsola(options = {}) {
  return new Consola(options);
}
function parseStack(stack, message) {
  const cwd = process.cwd() + sep;
  const lines = stack.split("\n").splice(message.split("\n").length).map((l2) => l2.trim().replace("file://", "").replace(cwd, ""));
  return lines;
}
function writeStream(data, stream) {
  const write = stream.__write || stream.write;
  return write.call(stream, data);
}
var bracket = (x2) => x2 ? `[${x2}]` : "";
var BasicReporter = class {
  formatStack(stack, message, opts) {
    const indent = "  ".repeat((opts?.errorLevel || 0) + 1);
    return indent + parseStack(stack, message).join(`
${indent}`);
  }
  formatError(err, opts) {
    const message = err.message ?? formatWithOptions(opts, err);
    const stack = err.stack ? this.formatStack(err.stack, message, opts) : "";
    const level = opts?.errorLevel || 0;
    const causedPrefix = level > 0 ? `${"  ".repeat(level)}[cause]: ` : "";
    const causedError = err.cause ? "\n\n" + this.formatError(err.cause, { ...opts, errorLevel: level + 1 }) : "";
    return causedPrefix + message + "\n" + stack + causedError;
  }
  formatArgs(args, opts) {
    const _args = args.map((arg) => {
      if (arg && typeof arg.stack === "string") {
        return this.formatError(arg, opts);
      }
      return arg;
    });
    return formatWithOptions(opts, ..._args);
  }
  formatDate(date, opts) {
    return opts.date ? date.toLocaleTimeString() : "";
  }
  filterAndJoin(arr) {
    return arr.filter(Boolean).join(" ");
  }
  formatLogObj(logObj, opts) {
    const message = this.formatArgs(logObj.args, opts);
    if (logObj.type === "box") {
      return "\n" + [
        bracket(logObj.tag),
        logObj.title && logObj.title,
        ...message.split("\n")
      ].filter(Boolean).map((l2) => " > " + l2).join("\n") + "\n";
    }
    return this.filterAndJoin([
      bracket(logObj.type),
      bracket(logObj.tag),
      message
    ]);
  }
  log(logObj, ctx) {
    const line = this.formatLogObj(logObj, {
      columns: ctx.options.stdout.columns || 0,
      ...ctx.options.formatOptions
    });
    return writeStream(
      line + "\n",
      logObj.level < 2 ? ctx.options.stderr || process.stderr : ctx.options.stdout || process.stdout
    );
  }
};
var {
  env = {},
  argv = [],
  platform = ""
} = typeof process === "undefined" ? {} : process;
var isDisabled = "NO_COLOR" in env || argv.includes("--no-color");
var isForced = "FORCE_COLOR" in env || argv.includes("--color");
var isWindows = platform === "win32";
var isDumbTerminal = env.TERM === "dumb";
var isCompatibleTerminal = tty && tty.isatty && tty.isatty(1) && env.TERM && !isDumbTerminal;
var isCI = "CI" in env && ("GITHUB_ACTIONS" in env || "GITLAB_CI" in env || "CIRCLECI" in env);
var isColorSupported = !isDisabled && (isForced || isWindows && !isDumbTerminal || isCompatibleTerminal || isCI);
function replaceClose(index, string, close, replace, head = string.slice(0, Math.max(0, index)) + replace, tail = string.slice(Math.max(0, index + close.length)), next = tail.indexOf(close)) {
  return head + (next < 0 ? tail : replaceClose(next, tail, close, replace));
}
function clearBleed(index, string, open, close, replace) {
  return index < 0 ? open + string + close : open + replaceClose(index, string, close, replace) + close;
}
function filterEmpty(open, close, replace = open, at = open.length + 1) {
  return (string) => string || !(string === "" || string === void 0) ? clearBleed(
    ("" + string).indexOf(close, at),
    string,
    open,
    close,
    replace
  ) : "";
}
function init(open, close, replace) {
  return filterEmpty(`\x1B[${open}m`, `\x1B[${close}m`, replace);
}
var colorDefs = {
  reset: init(0, 0),
  bold: init(1, 22, "\x1B[22m\x1B[1m"),
  dim: init(2, 22, "\x1B[22m\x1B[2m"),
  italic: init(3, 23),
  underline: init(4, 24),
  inverse: init(7, 27),
  hidden: init(8, 28),
  strikethrough: init(9, 29),
  black: init(30, 39),
  red: init(31, 39),
  green: init(32, 39),
  yellow: init(33, 39),
  blue: init(34, 39),
  magenta: init(35, 39),
  cyan: init(36, 39),
  white: init(37, 39),
  gray: init(90, 39),
  bgBlack: init(40, 49),
  bgRed: init(41, 49),
  bgGreen: init(42, 49),
  bgYellow: init(43, 49),
  bgBlue: init(44, 49),
  bgMagenta: init(45, 49),
  bgCyan: init(46, 49),
  bgWhite: init(47, 49),
  blackBright: init(90, 39),
  redBright: init(91, 39),
  greenBright: init(92, 39),
  yellowBright: init(93, 39),
  blueBright: init(94, 39),
  magentaBright: init(95, 39),
  cyanBright: init(96, 39),
  whiteBright: init(97, 39),
  bgBlackBright: init(100, 49),
  bgRedBright: init(101, 49),
  bgGreenBright: init(102, 49),
  bgYellowBright: init(103, 49),
  bgBlueBright: init(104, 49),
  bgMagentaBright: init(105, 49),
  bgCyanBright: init(106, 49),
  bgWhiteBright: init(107, 49)
};
function createColors(useColor = isColorSupported) {
  return useColor ? colorDefs : Object.fromEntries(Object.keys(colorDefs).map((key) => [key, String]));
}
var colors = createColors();
function getColor(color, fallback = "reset") {
  return colors[color] || colors[fallback];
}
var ansiRegex = [
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)`,
  String.raw`(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`
].join("|");
function stripAnsi(text) {
  return text.replace(new RegExp(ansiRegex, "g"), "");
}
var boxStylePresets = {
  solid: {
    tl: "\u250C",
    tr: "\u2510",
    bl: "\u2514",
    br: "\u2518",
    h: "\u2500",
    v: "\u2502"
  },
  double: {
    tl: "\u2554",
    tr: "\u2557",
    bl: "\u255A",
    br: "\u255D",
    h: "\u2550",
    v: "\u2551"
  },
  doubleSingle: {
    tl: "\u2553",
    tr: "\u2556",
    bl: "\u2559",
    br: "\u255C",
    h: "\u2500",
    v: "\u2551"
  },
  doubleSingleRounded: {
    tl: "\u256D",
    tr: "\u256E",
    bl: "\u2570",
    br: "\u256F",
    h: "\u2500",
    v: "\u2551"
  },
  singleThick: {
    tl: "\u250F",
    tr: "\u2513",
    bl: "\u2517",
    br: "\u251B",
    h: "\u2501",
    v: "\u2503"
  },
  singleDouble: {
    tl: "\u2552",
    tr: "\u2555",
    bl: "\u2558",
    br: "\u255B",
    h: "\u2550",
    v: "\u2502"
  },
  singleDoubleRounded: {
    tl: "\u256D",
    tr: "\u256E",
    bl: "\u2570",
    br: "\u256F",
    h: "\u2550",
    v: "\u2502"
  },
  rounded: {
    tl: "\u256D",
    tr: "\u256E",
    bl: "\u2570",
    br: "\u256F",
    h: "\u2500",
    v: "\u2502"
  }
};
var defaultStyle = {
  borderColor: "white",
  borderStyle: "rounded",
  valign: "center",
  padding: 2,
  marginLeft: 1,
  marginTop: 1,
  marginBottom: 1
};
function box(text, _opts = {}) {
  const opts = {
    ..._opts,
    style: {
      ...defaultStyle,
      ..._opts.style
    }
  };
  const textLines = text.split("\n");
  const boxLines = [];
  const _color = getColor(opts.style.borderColor);
  const borderStyle = {
    ...typeof opts.style.borderStyle === "string" ? boxStylePresets[opts.style.borderStyle] || boxStylePresets.solid : opts.style.borderStyle
  };
  if (_color) {
    for (const key in borderStyle) {
      borderStyle[key] = _color(
        borderStyle[key]
      );
    }
  }
  const paddingOffset = opts.style.padding % 2 === 0 ? opts.style.padding : opts.style.padding + 1;
  const height = textLines.length + paddingOffset;
  const width = Math.max(
    ...textLines.map((line) => stripAnsi(line).length),
    opts.title ? stripAnsi(opts.title).length : 0
  ) + paddingOffset;
  const widthOffset = width + paddingOffset;
  const leftSpace = opts.style.marginLeft > 0 ? " ".repeat(opts.style.marginLeft) : "";
  if (opts.style.marginTop > 0) {
    boxLines.push("".repeat(opts.style.marginTop));
  }
  if (opts.title) {
    const title = _color ? _color(opts.title) : opts.title;
    const left = borderStyle.h.repeat(
      Math.floor((width - stripAnsi(opts.title).length) / 2)
    );
    const right = borderStyle.h.repeat(
      width - stripAnsi(opts.title).length - stripAnsi(left).length + paddingOffset
    );
    boxLines.push(
      `${leftSpace}${borderStyle.tl}${left}${title}${right}${borderStyle.tr}`
    );
  } else {
    boxLines.push(
      `${leftSpace}${borderStyle.tl}${borderStyle.h.repeat(widthOffset)}${borderStyle.tr}`
    );
  }
  const valignOffset = opts.style.valign === "center" ? Math.floor((height - textLines.length) / 2) : opts.style.valign === "top" ? height - textLines.length - paddingOffset : height - textLines.length;
  for (let i2 = 0; i2 < height; i2++) {
    if (i2 < valignOffset || i2 >= valignOffset + textLines.length) {
      boxLines.push(
        `${leftSpace}${borderStyle.v}${" ".repeat(widthOffset)}${borderStyle.v}`
      );
    } else {
      const line = textLines[i2 - valignOffset];
      const left = " ".repeat(paddingOffset);
      const right = " ".repeat(width - stripAnsi(line).length);
      boxLines.push(
        `${leftSpace}${borderStyle.v}${left}${line}${right}${borderStyle.v}`
      );
    }
  }
  boxLines.push(
    `${leftSpace}${borderStyle.bl}${borderStyle.h.repeat(widthOffset)}${borderStyle.br}`
  );
  if (opts.style.marginBottom > 0) {
    boxLines.push("".repeat(opts.style.marginBottom));
  }
  return boxLines.join("\n");
}
var r2 = /* @__PURE__ */ Object.create(null);
var i = (e2) => globalThis.process?.env || import.meta.env || globalThis.Deno?.env.toObject() || globalThis.__env__ || (e2 ? r2 : globalThis);
var o2 = new Proxy(r2, { get(e2, s2) {
  return i()[s2] ?? r2[s2];
}, has(e2, s2) {
  const E = i();
  return s2 in E || s2 in r2;
}, set(e2, s2, E) {
  const B2 = i(true);
  return B2[s2] = E, true;
}, deleteProperty(e2, s2) {
  if (!s2) return false;
  const E = i(true);
  return delete E[s2], true;
}, ownKeys() {
  const e2 = i(true);
  return Object.keys(e2);
} });
var t = typeof process < "u" && process.env && process.env.NODE_ENV || "";
var f2 = [["APPVEYOR"], ["AWS_AMPLIFY", "AWS_APP_ID", { ci: true }], ["AZURE_PIPELINES", "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI"], ["AZURE_STATIC", "INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN"], ["APPCIRCLE", "AC_APPCIRCLE"], ["BAMBOO", "bamboo_planKey"], ["BITBUCKET", "BITBUCKET_COMMIT"], ["BITRISE", "BITRISE_IO"], ["BUDDY", "BUDDY_WORKSPACE_ID"], ["BUILDKITE"], ["CIRCLE", "CIRCLECI"], ["CIRRUS", "CIRRUS_CI"], ["CLOUDFLARE_PAGES", "CF_PAGES", { ci: true }], ["CODEBUILD", "CODEBUILD_BUILD_ARN"], ["CODEFRESH", "CF_BUILD_ID"], ["DRONE"], ["DRONE", "DRONE_BUILD_EVENT"], ["DSARI"], ["GITHUB_ACTIONS"], ["GITLAB", "GITLAB_CI"], ["GITLAB", "CI_MERGE_REQUEST_ID"], ["GOCD", "GO_PIPELINE_LABEL"], ["LAYERCI"], ["HUDSON", "HUDSON_URL"], ["JENKINS", "JENKINS_URL"], ["MAGNUM"], ["NETLIFY"], ["NETLIFY", "NETLIFY_LOCAL", { ci: false }], ["NEVERCODE"], ["RENDER"], ["SAIL", "SAILCI"], ["SEMAPHORE"], ["SCREWDRIVER"], ["SHIPPABLE"], ["SOLANO", "TDDIUM"], ["STRIDER"], ["TEAMCITY", "TEAMCITY_VERSION"], ["TRAVIS"], ["VERCEL", "NOW_BUILDER"], ["VERCEL", "VERCEL", { ci: false }], ["VERCEL", "VERCEL_ENV", { ci: false }], ["APPCENTER", "APPCENTER_BUILD_ID"], ["CODESANDBOX", "CODESANDBOX_SSE", { ci: false }], ["CODESANDBOX", "CODESANDBOX_HOST", { ci: false }], ["STACKBLITZ"], ["STORMKIT"], ["CLEAVR"], ["ZEABUR"], ["CODESPHERE", "CODESPHERE_APP_ID", { ci: true }], ["RAILWAY", "RAILWAY_PROJECT_ID"], ["RAILWAY", "RAILWAY_SERVICE_ID"], ["DENO-DEPLOY", "DENO_DEPLOYMENT_ID"], ["FIREBASE_APP_HOSTING", "FIREBASE_APP_HOSTING", { ci: true }]];
function b() {
  if (globalThis.process?.env) for (const e2 of f2) {
    const s2 = e2[1] || e2[0];
    if (globalThis.process?.env[s2]) return { name: e2[0].toLowerCase(), ...e2[2] };
  }
  return globalThis.process?.env?.SHELL === "/bin/jsh" && globalThis.process?.versions?.webcontainer ? { name: "stackblitz", ci: false } : { name: "", ci: false };
}
var l = b();
l.name;
function n(e2) {
  return e2 ? e2 !== "false" : false;
}
var I2 = globalThis.process?.platform || "";
var T2 = n(o2.CI) || l.ci !== false;
var a = n(globalThis.process?.stdout && globalThis.process?.stdout.isTTY);
var g2 = n(o2.DEBUG);
var R2 = t === "test" || n(o2.TEST);
n(o2.MINIMAL) || T2 || R2 || !a;
var A2 = /^win/i.test(I2);
!n(o2.NO_COLOR) && (n(o2.FORCE_COLOR) || (a || A2) && o2.TERM !== "dumb" || T2);
var C2 = (globalThis.process?.versions?.node || "").replace(/^v/, "") || null;
Number(C2?.split(".")[0]) || null;
var y2 = globalThis.process || /* @__PURE__ */ Object.create(null);
var _2 = { versions: {} };
new Proxy(y2, { get(e2, s2) {
  if (s2 === "env") return o2;
  if (s2 in e2) return e2[s2];
  if (s2 in _2) return _2[s2];
} });
var c2 = globalThis.process?.release?.name === "node";
var O2 = !!globalThis.Bun || !!globalThis.process?.versions?.bun;
var D = !!globalThis.Deno;
var L2 = !!globalThis.fastly;
var S2 = !!globalThis.Netlify;
var u2 = !!globalThis.EdgeRuntime;
var N2 = globalThis.navigator?.userAgent === "Cloudflare-Workers";
var F2 = [[S2, "netlify"], [u2, "edge-light"], [N2, "workerd"], [L2, "fastly"], [D, "deno"], [O2, "bun"], [c2, "node"]];
function G2() {
  const e2 = F2.find((s2) => s2[0]);
  if (e2) return { name: e2[1] };
}
var P2 = G2();
P2?.name || "";
function ansiRegex2({ onlyFirst = false } = {}) {
  const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
  const pattern = [
    `[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${ST})`,
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"
  ].join("|");
  return new RegExp(pattern, onlyFirst ? void 0 : "g");
}
var regex = ansiRegex2();
function stripAnsi2(string) {
  if (typeof string !== "string") {
    throw new TypeError(`Expected a \`string\`, got \`${typeof string}\``);
  }
  return string.replace(regex, "");
}
function isAmbiguous(x2) {
  return x2 === 161 || x2 === 164 || x2 === 167 || x2 === 168 || x2 === 170 || x2 === 173 || x2 === 174 || x2 >= 176 && x2 <= 180 || x2 >= 182 && x2 <= 186 || x2 >= 188 && x2 <= 191 || x2 === 198 || x2 === 208 || x2 === 215 || x2 === 216 || x2 >= 222 && x2 <= 225 || x2 === 230 || x2 >= 232 && x2 <= 234 || x2 === 236 || x2 === 237 || x2 === 240 || x2 === 242 || x2 === 243 || x2 >= 247 && x2 <= 250 || x2 === 252 || x2 === 254 || x2 === 257 || x2 === 273 || x2 === 275 || x2 === 283 || x2 === 294 || x2 === 295 || x2 === 299 || x2 >= 305 && x2 <= 307 || x2 === 312 || x2 >= 319 && x2 <= 322 || x2 === 324 || x2 >= 328 && x2 <= 331 || x2 === 333 || x2 === 338 || x2 === 339 || x2 === 358 || x2 === 359 || x2 === 363 || x2 === 462 || x2 === 464 || x2 === 466 || x2 === 468 || x2 === 470 || x2 === 472 || x2 === 474 || x2 === 476 || x2 === 593 || x2 === 609 || x2 === 708 || x2 === 711 || x2 >= 713 && x2 <= 715 || x2 === 717 || x2 === 720 || x2 >= 728 && x2 <= 731 || x2 === 733 || x2 === 735 || x2 >= 768 && x2 <= 879 || x2 >= 913 && x2 <= 929 || x2 >= 931 && x2 <= 937 || x2 >= 945 && x2 <= 961 || x2 >= 963 && x2 <= 969 || x2 === 1025 || x2 >= 1040 && x2 <= 1103 || x2 === 1105 || x2 === 8208 || x2 >= 8211 && x2 <= 8214 || x2 === 8216 || x2 === 8217 || x2 === 8220 || x2 === 8221 || x2 >= 8224 && x2 <= 8226 || x2 >= 8228 && x2 <= 8231 || x2 === 8240 || x2 === 8242 || x2 === 8243 || x2 === 8245 || x2 === 8251 || x2 === 8254 || x2 === 8308 || x2 === 8319 || x2 >= 8321 && x2 <= 8324 || x2 === 8364 || x2 === 8451 || x2 === 8453 || x2 === 8457 || x2 === 8467 || x2 === 8470 || x2 === 8481 || x2 === 8482 || x2 === 8486 || x2 === 8491 || x2 === 8531 || x2 === 8532 || x2 >= 8539 && x2 <= 8542 || x2 >= 8544 && x2 <= 8555 || x2 >= 8560 && x2 <= 8569 || x2 === 8585 || x2 >= 8592 && x2 <= 8601 || x2 === 8632 || x2 === 8633 || x2 === 8658 || x2 === 8660 || x2 === 8679 || x2 === 8704 || x2 === 8706 || x2 === 8707 || x2 === 8711 || x2 === 8712 || x2 === 8715 || x2 === 8719 || x2 === 8721 || x2 === 8725 || x2 === 8730 || x2 >= 8733 && x2 <= 8736 || x2 === 8739 || x2 === 8741 || x2 >= 8743 && x2 <= 8748 || x2 === 8750 || x2 >= 8756 && x2 <= 8759 || x2 === 8764 || x2 === 8765 || x2 === 8776 || x2 === 8780 || x2 === 8786 || x2 === 8800 || x2 === 8801 || x2 >= 8804 && x2 <= 8807 || x2 === 8810 || x2 === 8811 || x2 === 8814 || x2 === 8815 || x2 === 8834 || x2 === 8835 || x2 === 8838 || x2 === 8839 || x2 === 8853 || x2 === 8857 || x2 === 8869 || x2 === 8895 || x2 === 8978 || x2 >= 9312 && x2 <= 9449 || x2 >= 9451 && x2 <= 9547 || x2 >= 9552 && x2 <= 9587 || x2 >= 9600 && x2 <= 9615 || x2 >= 9618 && x2 <= 9621 || x2 === 9632 || x2 === 9633 || x2 >= 9635 && x2 <= 9641 || x2 === 9650 || x2 === 9651 || x2 === 9654 || x2 === 9655 || x2 === 9660 || x2 === 9661 || x2 === 9664 || x2 === 9665 || x2 >= 9670 && x2 <= 9672 || x2 === 9675 || x2 >= 9678 && x2 <= 9681 || x2 >= 9698 && x2 <= 9701 || x2 === 9711 || x2 === 9733 || x2 === 9734 || x2 === 9737 || x2 === 9742 || x2 === 9743 || x2 === 9756 || x2 === 9758 || x2 === 9792 || x2 === 9794 || x2 === 9824 || x2 === 9825 || x2 >= 9827 && x2 <= 9829 || x2 >= 9831 && x2 <= 9834 || x2 === 9836 || x2 === 9837 || x2 === 9839 || x2 === 9886 || x2 === 9887 || x2 === 9919 || x2 >= 9926 && x2 <= 9933 || x2 >= 9935 && x2 <= 9939 || x2 >= 9941 && x2 <= 9953 || x2 === 9955 || x2 === 9960 || x2 === 9961 || x2 >= 9963 && x2 <= 9969 || x2 === 9972 || x2 >= 9974 && x2 <= 9977 || x2 === 9979 || x2 === 9980 || x2 === 9982 || x2 === 9983 || x2 === 10045 || x2 >= 10102 && x2 <= 10111 || x2 >= 11094 && x2 <= 11097 || x2 >= 12872 && x2 <= 12879 || x2 >= 57344 && x2 <= 63743 || x2 >= 65024 && x2 <= 65039 || x2 === 65533 || x2 >= 127232 && x2 <= 127242 || x2 >= 127248 && x2 <= 127277 || x2 >= 127280 && x2 <= 127337 || x2 >= 127344 && x2 <= 127373 || x2 === 127375 || x2 === 127376 || x2 >= 127387 && x2 <= 127404 || x2 >= 917760 && x2 <= 917999 || x2 >= 983040 && x2 <= 1048573 || x2 >= 1048576 && x2 <= 1114109;
}
function isFullWidth(x2) {
  return x2 === 12288 || x2 >= 65281 && x2 <= 65376 || x2 >= 65504 && x2 <= 65510;
}
function isWide(x2) {
  return x2 >= 4352 && x2 <= 4447 || x2 === 8986 || x2 === 8987 || x2 === 9001 || x2 === 9002 || x2 >= 9193 && x2 <= 9196 || x2 === 9200 || x2 === 9203 || x2 === 9725 || x2 === 9726 || x2 === 9748 || x2 === 9749 || x2 >= 9776 && x2 <= 9783 || x2 >= 9800 && x2 <= 9811 || x2 === 9855 || x2 >= 9866 && x2 <= 9871 || x2 === 9875 || x2 === 9889 || x2 === 9898 || x2 === 9899 || x2 === 9917 || x2 === 9918 || x2 === 9924 || x2 === 9925 || x2 === 9934 || x2 === 9940 || x2 === 9962 || x2 === 9970 || x2 === 9971 || x2 === 9973 || x2 === 9978 || x2 === 9981 || x2 === 9989 || x2 === 9994 || x2 === 9995 || x2 === 10024 || x2 === 10060 || x2 === 10062 || x2 >= 10067 && x2 <= 10069 || x2 === 10071 || x2 >= 10133 && x2 <= 10135 || x2 === 10160 || x2 === 10175 || x2 === 11035 || x2 === 11036 || x2 === 11088 || x2 === 11093 || x2 >= 11904 && x2 <= 11929 || x2 >= 11931 && x2 <= 12019 || x2 >= 12032 && x2 <= 12245 || x2 >= 12272 && x2 <= 12287 || x2 >= 12289 && x2 <= 12350 || x2 >= 12353 && x2 <= 12438 || x2 >= 12441 && x2 <= 12543 || x2 >= 12549 && x2 <= 12591 || x2 >= 12593 && x2 <= 12686 || x2 >= 12688 && x2 <= 12773 || x2 >= 12783 && x2 <= 12830 || x2 >= 12832 && x2 <= 12871 || x2 >= 12880 && x2 <= 42124 || x2 >= 42128 && x2 <= 42182 || x2 >= 43360 && x2 <= 43388 || x2 >= 44032 && x2 <= 55203 || x2 >= 63744 && x2 <= 64255 || x2 >= 65040 && x2 <= 65049 || x2 >= 65072 && x2 <= 65106 || x2 >= 65108 && x2 <= 65126 || x2 >= 65128 && x2 <= 65131 || x2 >= 94176 && x2 <= 94180 || x2 === 94192 || x2 === 94193 || x2 >= 94208 && x2 <= 100343 || x2 >= 100352 && x2 <= 101589 || x2 >= 101631 && x2 <= 101640 || x2 >= 110576 && x2 <= 110579 || x2 >= 110581 && x2 <= 110587 || x2 === 110589 || x2 === 110590 || x2 >= 110592 && x2 <= 110882 || x2 === 110898 || x2 >= 110928 && x2 <= 110930 || x2 === 110933 || x2 >= 110948 && x2 <= 110951 || x2 >= 110960 && x2 <= 111355 || x2 >= 119552 && x2 <= 119638 || x2 >= 119648 && x2 <= 119670 || x2 === 126980 || x2 === 127183 || x2 === 127374 || x2 >= 127377 && x2 <= 127386 || x2 >= 127488 && x2 <= 127490 || x2 >= 127504 && x2 <= 127547 || x2 >= 127552 && x2 <= 127560 || x2 === 127568 || x2 === 127569 || x2 >= 127584 && x2 <= 127589 || x2 >= 127744 && x2 <= 127776 || x2 >= 127789 && x2 <= 127797 || x2 >= 127799 && x2 <= 127868 || x2 >= 127870 && x2 <= 127891 || x2 >= 127904 && x2 <= 127946 || x2 >= 127951 && x2 <= 127955 || x2 >= 127968 && x2 <= 127984 || x2 === 127988 || x2 >= 127992 && x2 <= 128062 || x2 === 128064 || x2 >= 128066 && x2 <= 128252 || x2 >= 128255 && x2 <= 128317 || x2 >= 128331 && x2 <= 128334 || x2 >= 128336 && x2 <= 128359 || x2 === 128378 || x2 === 128405 || x2 === 128406 || x2 === 128420 || x2 >= 128507 && x2 <= 128591 || x2 >= 128640 && x2 <= 128709 || x2 === 128716 || x2 >= 128720 && x2 <= 128722 || x2 >= 128725 && x2 <= 128727 || x2 >= 128732 && x2 <= 128735 || x2 === 128747 || x2 === 128748 || x2 >= 128756 && x2 <= 128764 || x2 >= 128992 && x2 <= 129003 || x2 === 129008 || x2 >= 129292 && x2 <= 129338 || x2 >= 129340 && x2 <= 129349 || x2 >= 129351 && x2 <= 129535 || x2 >= 129648 && x2 <= 129660 || x2 >= 129664 && x2 <= 129673 || x2 >= 129679 && x2 <= 129734 || x2 >= 129742 && x2 <= 129756 || x2 >= 129759 && x2 <= 129769 || x2 >= 129776 && x2 <= 129784 || x2 >= 131072 && x2 <= 196605 || x2 >= 196608 && x2 <= 262141;
}
function validate(codePoint) {
  if (!Number.isSafeInteger(codePoint)) {
    throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
  }
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  validate(codePoint);
  if (isFullWidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) {
    return 2;
  }
  return 1;
}
var emojiRegex = () => {
  return /[#*0-9]\uFE0F?\u20E3|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26AA\u26B0\u26B1\u26BD\u26BE\u26C4\u26C8\u26CF\u26D1\u26E9\u26F0-\u26F5\u26F7\u26F8\u26FA\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B55\u3030\u303D\u3297\u3299]\uFE0F?|[\u261D\u270C\u270D](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\u270A\u270B](?:\uD83C[\uDFFB-\uDFFF])?|[\u23E9-\u23EC\u23F0\u23F3\u25FD\u2693\u26A1\u26AB\u26C5\u26CE\u26D4\u26EA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u27B0\u27BF\u2B50]|\u26D3\uFE0F?(?:\u200D\uD83D\uDCA5)?|\u26F9(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\u2764\uFE0F?(?:\u200D(?:\uD83D\uDD25|\uD83E\uDE79))?|\uD83C(?:[\uDC04\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]\uFE0F?|[\uDF85\uDFC2\uDFC7](?:\uD83C[\uDFFB-\uDFFF])?|[\uDFC4\uDFCA](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDFCB\uDFCC](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF43\uDF45-\uDF4A\uDF4C-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uDDE6\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF]|\uDDE7\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF]|\uDDE8\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF7\uDDFA-\uDDFF]|\uDDE9\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF]|\uDDEA\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA]|\uDDEB\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7]|\uDDEC\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE]|\uDDED\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA]|\uDDEE\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9]|\uDDEF\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5]|\uDDF0\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF]|\uDDF1\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE]|\uDDF2\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF]|\uDDF3\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF]|\uDDF4\uD83C\uDDF2|\uDDF5\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE]|\uDDF6\uD83C\uDDE6|\uDDF7\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC]|\uDDF8\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF]|\uDDF9\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF]|\uDDFA\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF]|\uDDFB\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA]|\uDDFC\uD83C[\uDDEB\uDDF8]|\uDDFD\uD83C\uDDF0|\uDDFE\uD83C[\uDDEA\uDDF9]|\uDDFF\uD83C[\uDDE6\uDDF2\uDDFC]|\uDF44(?:\u200D\uD83D\uDFEB)?|\uDF4B(?:\u200D\uD83D\uDFE9)?|\uDFC3(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDFF3\uFE0F?(?:\u200D(?:\u26A7\uFE0F?|\uD83C\uDF08))?|\uDFF4(?:\u200D\u2620\uFE0F?|\uDB40\uDC67\uDB40\uDC62\uDB40(?:\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDC73\uDB40\uDC63\uDB40\uDC74|\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F)?)|\uD83D(?:[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3]\uFE0F?|[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC](?:\uD83C[\uDFFB-\uDFFF])?|[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4\uDEB5](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD74\uDD90](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC25\uDC27-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE41\uDE43\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED7\uDEDC-\uDEDF\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB\uDFF0]|\uDC08(?:\u200D\u2B1B)?|\uDC15(?:\u200D\uD83E\uDDBA)?|\uDC26(?:\u200D(?:\u2B1B|\uD83D\uDD25))?|\uDC3B(?:\u200D\u2744\uFE0F?)?|\uDC41\uFE0F?(?:\u200D\uD83D\uDDE8\uFE0F?)?|\uDC68(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDC68\uDC69]\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE])))?))?|\uDC69(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?[\uDC68\uDC69]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?|\uDC69\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?))|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFE])))?))?|\uDC6F(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDD75(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDE2E(?:\u200D\uD83D\uDCA8)?|\uDE35(?:\u200D\uD83D\uDCAB)?|\uDE36(?:\u200D\uD83C\uDF2B\uFE0F?)?|\uDE42(?:\u200D[\u2194\u2195]\uFE0F?)?|\uDEB6(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?)|\uD83E(?:[\uDD0C\uDD0F\uDD18-\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5\uDEC3-\uDEC5\uDEF0\uDEF2-\uDEF8](?:\uD83C[\uDFFB-\uDFFF])?|[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD\uDDCF\uDDD4\uDDD6-\uDDDD](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDDDE\uDDDF](?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD0D\uDD0E\uDD10-\uDD17\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCC\uDDD0\uDDE0-\uDDFF\uDE70-\uDE7C\uDE80-\uDE89\uDE8F-\uDEC2\uDEC6\uDECE-\uDEDC\uDEDF-\uDEE9]|\uDD3C(?:\u200D[\u2640\u2642]\uFE0F?|\uD83C[\uDFFB-\uDFFF])?|\uDDCE(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDDD1(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1|\uDDD1\u200D\uD83E\uDDD2(?:\u200D\uD83E\uDDD2)?|\uDDD2(?:\u200D\uD83E\uDDD2)?))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?))?|\uDEF1(?:\uD83C(?:\uDFFB(?:\u200D\uD83E\uDEF2\uD83C[\uDFFC-\uDFFF])?|\uDFFC(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFD-\uDFFF])?|\uDFFD(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])?|\uDFFE(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFD\uDFFF])?|\uDFFF(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFE])?))?)/g;
};
var segmenter = globalThis.Intl?.Segmenter ? new Intl.Segmenter() : { segment: (str) => str.split("") };
var defaultIgnorableCodePointRegex = new RegExp("^\\p{Default_Ignorable_Code_Point}$", "u");
function stringWidth$1(string, options = {}) {
  if (typeof string !== "string" || string.length === 0) {
    return 0;
  }
  const {
    ambiguousIsNarrow = true,
    countAnsiEscapeCodes = false
  } = options;
  if (!countAnsiEscapeCodes) {
    string = stripAnsi2(string);
  }
  if (string.length === 0) {
    return 0;
  }
  let width = 0;
  const eastAsianWidthOptions = { ambiguousAsWide: !ambiguousIsNarrow };
  for (const { segment: character } of segmenter.segment(string)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint >= 127 && codePoint <= 159) {
      continue;
    }
    if (codePoint >= 8203 && codePoint <= 8207 || codePoint === 65279) {
      continue;
    }
    if (codePoint >= 768 && codePoint <= 879 || codePoint >= 6832 && codePoint <= 6911 || codePoint >= 7616 && codePoint <= 7679 || codePoint >= 8400 && codePoint <= 8447 || codePoint >= 65056 && codePoint <= 65071) {
      continue;
    }
    if (codePoint >= 55296 && codePoint <= 57343) {
      continue;
    }
    if (codePoint >= 65024 && codePoint <= 65039) {
      continue;
    }
    if (defaultIgnorableCodePointRegex.test(character)) {
      continue;
    }
    if (emojiRegex().test(character)) {
      width += 2;
      continue;
    }
    width += eastAsianWidth(codePoint, eastAsianWidthOptions);
  }
  return width;
}
function isUnicodeSupported() {
  const { env: env2 } = g;
  const { TERM, TERM_PROGRAM } = env2;
  if (g.platform !== "win32") {
    return TERM !== "linux";
  }
  return Boolean(env2.WT_SESSION) || Boolean(env2.TERMINUS_SUBLIME) || env2.ConEmuTask === "{cmd::Cmder}" || TERM_PROGRAM === "Terminus-Sublime" || TERM_PROGRAM === "vscode" || TERM === "xterm-256color" || TERM === "alacritty" || TERM === "rxvt-unicode" || TERM === "rxvt-unicode-256color" || env2.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var TYPE_COLOR_MAP = {
  info: "cyan",
  fail: "red",
  success: "green",
  ready: "green",
  start: "magenta"
};
var LEVEL_COLOR_MAP = {
  0: "red",
  1: "yellow"
};
var unicode = isUnicodeSupported();
var s = (c3, fallback) => unicode ? c3 : fallback;
var TYPE_ICONS = {
  error: s("\u2716", "\xD7"),
  fatal: s("\u2716", "\xD7"),
  ready: s("\u2714", "\u221A"),
  warn: s("\u26A0", "\u203C"),
  info: s("\u2139", "i"),
  success: s("\u2714", "\u221A"),
  debug: s("\u2699", "D"),
  trace: s("\u2192", "\u2192"),
  fail: s("\u2716", "\xD7"),
  start: s("\u25D0", "o"),
  log: ""
};
function stringWidth(str) {
  const hasICU = typeof Intl === "object";
  if (!hasICU || !Intl.Segmenter) {
    return stripAnsi(str).length;
  }
  return stringWidth$1(str);
}
var FancyReporter = class extends BasicReporter {
  formatStack(stack, message, opts) {
    const indent = "  ".repeat((opts?.errorLevel || 0) + 1);
    return `
${indent}` + parseStack(stack, message).map(
      (line) => "  " + line.replace(/^at +/, (m2) => colors.gray(m2)).replace(/\((.+)\)/, (_3, m2) => `(${colors.cyan(m2)})`)
    ).join(`
${indent}`);
  }
  formatType(logObj, isBadge, opts) {
    const typeColor = TYPE_COLOR_MAP[logObj.type] || LEVEL_COLOR_MAP[logObj.level] || "gray";
    if (isBadge) {
      return getBgColor(typeColor)(
        colors.black(` ${logObj.type.toUpperCase()} `)
      );
    }
    const _type = typeof TYPE_ICONS[logObj.type] === "string" ? TYPE_ICONS[logObj.type] : logObj.icon || logObj.type;
    return _type ? getColor2(typeColor)(_type) : "";
  }
  formatLogObj(logObj, opts) {
    const [message, ...additional] = this.formatArgs(logObj.args, opts).split(
      "\n"
    );
    if (logObj.type === "box") {
      return box(
        characterFormat(
          message + (additional.length > 0 ? "\n" + additional.join("\n") : "")
        ),
        {
          title: logObj.title ? characterFormat(logObj.title) : void 0,
          style: logObj.style
        }
      );
    }
    const date = this.formatDate(logObj.date, opts);
    const coloredDate = date && colors.gray(date);
    const isBadge = logObj.badge ?? logObj.level < 2;
    const type = this.formatType(logObj, isBadge, opts);
    const tag = logObj.tag ? colors.gray(logObj.tag) : "";
    let line;
    const left = this.filterAndJoin([type, characterFormat(message)]);
    const right = this.filterAndJoin(opts.columns ? [tag, coloredDate] : [tag]);
    const space = (opts.columns || 0) - stringWidth(left) - stringWidth(right) - 2;
    line = space > 0 && (opts.columns || 0) >= 80 ? left + " ".repeat(space) + right : (right ? `${colors.gray(`[${right}]`)} ` : "") + left;
    line += characterFormat(
      additional.length > 0 ? "\n" + additional.join("\n") : ""
    );
    if (logObj.type === "trace") {
      const _err = new Error("Trace: " + logObj.message);
      line += this.formatStack(_err.stack || "", _err.message);
    }
    return isBadge ? "\n" + line + "\n" : line;
  }
};
function characterFormat(str) {
  return str.replace(/`([^`]+)`/gm, (_3, m2) => colors.cyan(m2)).replace(/\s+_([^_]+)_\s+/gm, (_3, m2) => ` ${colors.underline(m2)} `);
}
function getColor2(color = "white") {
  return colors[color] || colors.white;
}
function getBgColor(color = "bgWhite") {
  return colors[`bg${color[0].toUpperCase()}${color.slice(1)}`] || colors.bgWhite;
}
function createConsola2(options = {}) {
  let level = _getDefaultLogLevel();
  if (process.env.CONSOLA_LEVEL) {
    level = Number.parseInt(process.env.CONSOLA_LEVEL) ?? level;
  }
  const consola2 = createConsola({
    level,
    defaults: { level },
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: (...args) => Promise.resolve().then(() => (init_prompt(), prompt_exports)).then((m2) => m2.prompt(...args)),
    reporters: options.reporters || [
      options.fancy ?? !(T2 || R2) ? new FancyReporter() : new BasicReporter()
    ],
    ...options
  });
  return consola2;
}
function _getDefaultLogLevel() {
  if (g2) {
    return LogLevels.debug;
  }
  if (R2) {
    return LogLevels.warn;
  }
  return LogLevels.info;
}
var consola = createConsola2();

// node_modules/citty/dist/index.mjs
function toArray(val) {
  if (Array.isArray(val)) {
    return val;
  }
  return val === void 0 ? [] : [val];
}
function formatLineColumns(lines, linePrefix = "") {
  const maxLengh = [];
  for (const line of lines) {
    for (const [i2, element] of line.entries()) {
      maxLengh[i2] = Math.max(maxLengh[i2] || 0, element.length);
    }
  }
  return lines.map(
    (l2) => l2.map(
      (c3, i2) => linePrefix + c3[i2 === 0 ? "padStart" : "padEnd"](maxLengh[i2])
    ).join("  ")
  ).join("\n");
}
function resolveValue(input) {
  return typeof input === "function" ? input() : input;
}
var CLIError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "CLIError";
  }
};
var NUMBER_CHAR_RE = /\d/;
var STR_SPLITTERS = ["-", "_", "/", "."];
function isUppercase(char = "") {
  if (NUMBER_CHAR_RE.test(char)) {
    return void 0;
  }
  return char !== char.toLowerCase();
}
function splitByCase(str, separators) {
  const splitters = STR_SPLITTERS;
  const parts = [];
  if (!str || typeof str !== "string") {
    return parts;
  }
  let buff = "";
  let previousUpper;
  let previousSplitter;
  for (const char of str) {
    const isSplitter = splitters.includes(char);
    if (isSplitter === true) {
      parts.push(buff);
      buff = "";
      previousUpper = void 0;
      continue;
    }
    const isUpper = isUppercase(char);
    if (previousSplitter === false) {
      if (previousUpper === false && isUpper === true) {
        parts.push(buff);
        buff = char;
        previousUpper = isUpper;
        continue;
      }
      if (previousUpper === true && isUpper === false && buff.length > 1) {
        const lastChar = buff.at(-1);
        parts.push(buff.slice(0, Math.max(0, buff.length - 1)));
        buff = lastChar + char;
        previousUpper = isUpper;
        continue;
      }
    }
    buff += char;
    previousUpper = isUpper;
    previousSplitter = isSplitter;
  }
  parts.push(buff);
  return parts;
}
function upperFirst(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : "";
}
function lowerFirst(str) {
  return str ? str[0].toLowerCase() + str.slice(1) : "";
}
function pascalCase(str, opts) {
  return str ? (Array.isArray(str) ? str : splitByCase(str)).map((p) => upperFirst(p)).join("") : "";
}
function camelCase(str, opts) {
  return lowerFirst(pascalCase(str || ""));
}
function kebabCase(str, joiner) {
  return str ? (Array.isArray(str) ? str : splitByCase(str)).map((p) => p.toLowerCase()).join("-") : "";
}
function toArr(any) {
  return any == void 0 ? [] : Array.isArray(any) ? any : [any];
}
function toVal(out, key, val, opts) {
  let x2;
  const old = out[key];
  const nxt = ~opts.string.indexOf(key) ? val == void 0 || val === true ? "" : String(val) : typeof val === "boolean" ? val : ~opts.boolean.indexOf(key) ? val === "false" ? false : val === "true" || (out._.push((x2 = +val, x2 * 0 === 0) ? x2 : val), !!val) : (x2 = +val, x2 * 0 === 0) ? x2 : val;
  out[key] = old == void 0 ? nxt : Array.isArray(old) ? old.concat(nxt) : [old, nxt];
}
function parseRawArgs(args = [], opts = {}) {
  let k2;
  let arr;
  let arg;
  let name;
  let val;
  const out = { _: [] };
  let i2 = 0;
  let j = 0;
  let idx = 0;
  const len = args.length;
  const alibi = opts.alias !== void 0;
  const strict = opts.unknown !== void 0;
  const defaults = opts.default !== void 0;
  opts.alias = opts.alias || {};
  opts.string = toArr(opts.string);
  opts.boolean = toArr(opts.boolean);
  if (alibi) {
    for (k2 in opts.alias) {
      arr = opts.alias[k2] = toArr(opts.alias[k2]);
      for (i2 = 0; i2 < arr.length; i2++) {
        (opts.alias[arr[i2]] = arr.concat(k2)).splice(i2, 1);
      }
    }
  }
  for (i2 = opts.boolean.length; i2-- > 0; ) {
    arr = opts.alias[opts.boolean[i2]] || [];
    for (j = arr.length; j-- > 0; ) {
      opts.boolean.push(arr[j]);
    }
  }
  for (i2 = opts.string.length; i2-- > 0; ) {
    arr = opts.alias[opts.string[i2]] || [];
    for (j = arr.length; j-- > 0; ) {
      opts.string.push(arr[j]);
    }
  }
  if (defaults) {
    for (k2 in opts.default) {
      name = typeof opts.default[k2];
      arr = opts.alias[k2] = opts.alias[k2] || [];
      if (opts[name] !== void 0) {
        opts[name].push(k2);
        for (i2 = 0; i2 < arr.length; i2++) {
          opts[name].push(arr[i2]);
        }
      }
    }
  }
  const keys = strict ? Object.keys(opts.alias) : [];
  for (i2 = 0; i2 < len; i2++) {
    arg = args[i2];
    if (arg === "--") {
      out._ = out._.concat(args.slice(++i2));
      break;
    }
    for (j = 0; j < arg.length; j++) {
      if (arg.charCodeAt(j) !== 45) {
        break;
      }
    }
    if (j === 0) {
      out._.push(arg);
    } else if (arg.substring(j, j + 3) === "no-") {
      name = arg.slice(Math.max(0, j + 3));
      if (strict && !~keys.indexOf(name)) {
        return opts.unknown(arg);
      }
      out[name] = false;
    } else {
      for (idx = j + 1; idx < arg.length; idx++) {
        if (arg.charCodeAt(idx) === 61) {
          break;
        }
      }
      name = arg.substring(j, idx);
      val = arg.slice(Math.max(0, ++idx)) || i2 + 1 === len || ("" + args[i2 + 1]).charCodeAt(0) === 45 || args[++i2];
      arr = j === 2 ? [name] : name;
      for (idx = 0; idx < arr.length; idx++) {
        name = arr[idx];
        if (strict && !~keys.indexOf(name)) {
          return opts.unknown("-".repeat(j) + name);
        }
        toVal(out, name, idx + 1 < arr.length || val, opts);
      }
    }
  }
  if (defaults) {
    for (k2 in opts.default) {
      if (out[k2] === void 0) {
        out[k2] = opts.default[k2];
      }
    }
  }
  if (alibi) {
    for (k2 in out) {
      arr = opts.alias[k2] || [];
      while (arr.length > 0) {
        out[arr.shift()] = out[k2];
      }
    }
  }
  return out;
}
function parseArgs(rawArgs, argsDef) {
  const parseOptions = {
    boolean: [],
    string: [],
    mixed: [],
    alias: {},
    default: {}
  };
  const args = resolveArgs(argsDef);
  for (const arg of args) {
    if (arg.type === "positional") {
      continue;
    }
    if (arg.type === "string") {
      parseOptions.string.push(arg.name);
    } else if (arg.type === "boolean") {
      parseOptions.boolean.push(arg.name);
    }
    if (arg.default !== void 0) {
      parseOptions.default[arg.name] = arg.default;
    }
    if (arg.alias) {
      parseOptions.alias[arg.name] = arg.alias;
    }
  }
  const parsed = parseRawArgs(rawArgs, parseOptions);
  const [...positionalArguments] = parsed._;
  const parsedArgsProxy = new Proxy(parsed, {
    get(target, prop) {
      return target[prop] ?? target[camelCase(prop)] ?? target[kebabCase(prop)];
    }
  });
  for (const [, arg] of args.entries()) {
    if (arg.type === "positional") {
      const nextPositionalArgument = positionalArguments.shift();
      if (nextPositionalArgument !== void 0) {
        parsedArgsProxy[arg.name] = nextPositionalArgument;
      } else if (arg.default === void 0 && arg.required !== false) {
        throw new CLIError(
          `Missing required positional argument: ${arg.name.toUpperCase()}`,
          "EARG"
        );
      } else {
        parsedArgsProxy[arg.name] = arg.default;
      }
    } else if (arg.required && parsedArgsProxy[arg.name] === void 0) {
      throw new CLIError(`Missing required argument: --${arg.name}`, "EARG");
    }
  }
  return parsedArgsProxy;
}
function resolveArgs(argsDef) {
  const args = [];
  for (const [name, argDef] of Object.entries(argsDef || {})) {
    args.push({
      ...argDef,
      name,
      alias: toArray(argDef.alias)
    });
  }
  return args;
}
function defineCommand(def) {
  return def;
}
async function runCommand(cmd, opts) {
  const cmdArgs = await resolveValue(cmd.args || {});
  const parsedArgs = parseArgs(opts.rawArgs, cmdArgs);
  const context = {
    rawArgs: opts.rawArgs,
    args: parsedArgs,
    data: opts.data,
    cmd
  };
  if (typeof cmd.setup === "function") {
    await cmd.setup(context);
  }
  let result;
  try {
    const subCommands = await resolveValue(cmd.subCommands);
    if (subCommands && Object.keys(subCommands).length > 0) {
      const subCommandArgIndex = opts.rawArgs.findIndex(
        (arg) => !arg.startsWith("-")
      );
      const subCommandName = opts.rawArgs[subCommandArgIndex];
      if (subCommandName) {
        if (!subCommands[subCommandName]) {
          throw new CLIError(
            `Unknown command \`${subCommandName}\``,
            "E_UNKNOWN_COMMAND"
          );
        }
        const subCommand = await resolveValue(subCommands[subCommandName]);
        if (subCommand) {
          await runCommand(subCommand, {
            rawArgs: opts.rawArgs.slice(subCommandArgIndex + 1)
          });
        }
      } else if (!cmd.run) {
        throw new CLIError(`No command specified.`, "E_NO_COMMAND");
      }
    }
    if (typeof cmd.run === "function") {
      result = await cmd.run(context);
    }
  } finally {
    if (typeof cmd.cleanup === "function") {
      await cmd.cleanup(context);
    }
  }
  return { result };
}
async function resolveSubCommand(cmd, rawArgs, parent) {
  const subCommands = await resolveValue(cmd.subCommands);
  if (subCommands && Object.keys(subCommands).length > 0) {
    const subCommandArgIndex = rawArgs.findIndex((arg) => !arg.startsWith("-"));
    const subCommandName = rawArgs[subCommandArgIndex];
    const subCommand = await resolveValue(subCommands[subCommandName]);
    if (subCommand) {
      return resolveSubCommand(
        subCommand,
        rawArgs.slice(subCommandArgIndex + 1),
        cmd
      );
    }
  }
  return [cmd, parent];
}
async function showUsage(cmd, parent) {
  try {
    consola.log(await renderUsage(cmd, parent) + "\n");
  } catch (error) {
    consola.error(error);
  }
}
async function renderUsage(cmd, parent) {
  const cmdMeta = await resolveValue(cmd.meta || {});
  const cmdArgs = resolveArgs(await resolveValue(cmd.args || {}));
  const parentMeta = await resolveValue(parent?.meta || {});
  const commandName = `${parentMeta.name ? `${parentMeta.name} ` : ""}` + (cmdMeta.name || process.argv[1]);
  const argLines = [];
  const posLines = [];
  const commandsLines = [];
  const usageLine = [];
  for (const arg of cmdArgs) {
    if (arg.type === "positional") {
      const name = arg.name.toUpperCase();
      const isRequired = arg.required !== false && arg.default === void 0;
      const defaultHint = arg.default ? `="${arg.default}"` : "";
      posLines.push([
        "`" + name + defaultHint + "`",
        arg.description || "",
        arg.valueHint ? `<${arg.valueHint}>` : ""
      ]);
      usageLine.push(isRequired ? `<${name}>` : `[${name}]`);
    } else {
      const isRequired = arg.required === true && arg.default === void 0;
      const argStr = (arg.type === "boolean" && arg.default === true ? [
        ...(arg.alias || []).map((a2) => `--no-${a2}`),
        `--no-${arg.name}`
      ].join(", ") : [...(arg.alias || []).map((a2) => `-${a2}`), `--${arg.name}`].join(
        ", "
      )) + (arg.type === "string" && (arg.valueHint || arg.default) ? `=${arg.valueHint ? `<${arg.valueHint}>` : `"${arg.default || ""}"`}` : "");
      argLines.push([
        "`" + argStr + (isRequired ? " (required)" : "") + "`",
        arg.description || ""
      ]);
      if (isRequired) {
        usageLine.push(argStr);
      }
    }
  }
  if (cmd.subCommands) {
    const commandNames = [];
    const subCommands = await resolveValue(cmd.subCommands);
    for (const [name, sub] of Object.entries(subCommands)) {
      const subCmd = await resolveValue(sub);
      const meta = await resolveValue(subCmd?.meta);
      commandsLines.push([`\`${name}\``, meta?.description || ""]);
      commandNames.push(name);
    }
    usageLine.push(commandNames.join("|"));
  }
  const usageLines = [];
  const version = cmdMeta.version || parentMeta.version;
  usageLines.push(
    colors.gray(
      `${cmdMeta.description} (${commandName + (version ? ` v${version}` : "")})`
    ),
    ""
  );
  const hasOptions = argLines.length > 0 || posLines.length > 0;
  usageLines.push(
    `${colors.underline(colors.bold("USAGE"))} \`${commandName}${hasOptions ? " [OPTIONS]" : ""} ${usageLine.join(" ")}\``,
    ""
  );
  if (posLines.length > 0) {
    usageLines.push(colors.underline(colors.bold("ARGUMENTS")), "");
    usageLines.push(formatLineColumns(posLines, "  "));
    usageLines.push("");
  }
  if (argLines.length > 0) {
    usageLines.push(colors.underline(colors.bold("OPTIONS")), "");
    usageLines.push(formatLineColumns(argLines, "  "));
    usageLines.push("");
  }
  if (commandsLines.length > 0) {
    usageLines.push(colors.underline(colors.bold("COMMANDS")), "");
    usageLines.push(formatLineColumns(commandsLines, "  "));
    usageLines.push(
      "",
      `Use \`${commandName} <command> --help\` for more information about a command.`
    );
  }
  return usageLines.filter((l2) => typeof l2 === "string").join("\n");
}
async function runMain(cmd, opts = {}) {
  const rawArgs = opts.rawArgs || process.argv.slice(2);
  const showUsage$1 = opts.showUsage || showUsage;
  try {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      await showUsage$1(...await resolveSubCommand(cmd, rawArgs));
      process.exit(0);
    } else if (rawArgs.length === 1 && rawArgs[0] === "--version") {
      const meta = typeof cmd.meta === "function" ? await cmd.meta() : await cmd.meta;
      if (!meta?.version) {
        throw new CLIError("No version specified", "E_NO_VERSION");
      }
      consola.log(meta.version);
    } else {
      await runCommand(cmd, { rawArgs });
    }
  } catch (error) {
    const isCLIError = error instanceof CLIError;
    if (!isCLIError) {
      consola.error(error, "\n");
    }
    if (isCLIError) {
      await showUsage$1(...await resolveSubCommand(cmd, rawArgs));
    }
    consola.error(error.message);
    process.exit(1);
  }
}
var VAULT_CONFIG_RELATIVE_PATH = "00_index/vault.config.yml";
var VAULT_CONFIG_FILENAME = "vault.config.yml";
var NUMBERED_DIRECTORY = /^\d{2}_[a-z][a-z0-9_-]*$/iu;
var DEFAULT_CONFIG = {
  version: 1,
  root_label: "OpenBrain",
  paths: {
    index: "00_index",
    deltas: "00_index/deltas",
    catalog: "00_index/catalog.json",
    catalog_shards: "00_index/catalog",
    catalog_index: "00_index/catalog/catalog_index.json",
    graph: "00_index/graph.json",
    freshness: "00_index/freshness.json",
    routing: "00_index/routing.yml",
    archive: "90_archive",
    inbox: "01_inbox",
    memory: "10_memory",
    contexts: "20_contexts",
    skills: "30_skills",
    sources: "40_sources",
    outputs: "50_outputs",
    engine: "70_engine"
  },
  exclusions: [
    ".git",
    ".DS_Store",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".open-brain",
    "70_engine"
  ],
  text_extensions: [
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".css",
    ".html",
    ".sh",
    ".csv",
    ".tsv",
    ".env",
    ".example"
  ],
  max_file_bytes: 768e3,
  paliers: {
    p1_max: 500,
    p2_max: 2e3,
    p3_max: 1e4,
    shard_from: "P2"
  },
  deltas: {
    retention: 30
  },
  thermal: {
    hot_max_days: 14,
    warm_max_days: 90
  },
  ephemeral: {
    ttl_days: 30
  },
  canonical_dirs: [
    "00_index",
    "01_inbox",
    "10_memory",
    "20_contexts",
    "30_skills",
    "40_sources",
    "50_outputs",
    "70_engine",
    "90_archive"
  ],
  activity: {
    active_paths: [],
    active_dir_prefixes: []
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)])
    );
  }
  return value;
}
function deepMerge(base, override) {
  const merged = cloneValue(base);
  for (const [key, value] of Object.entries(override)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else if (value !== null && value !== void 0) {
      merged[key] = cloneValue(value);
    }
  }
  return merged;
}
function asString(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function asPositiveInteger(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function asStringArray(value, fallback) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return [...fallback];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}
function asTier(value, fallback) {
  return value === "P1" || value === "P2" || value === "P3" || value === "P4" ? value : fallback;
}
function normalizeConfig(value) {
  const config = cloneValue(value);
  config.version = asPositiveInteger(config.version, DEFAULT_CONFIG.version);
  config.root_label = asString(config.root_label, DEFAULT_CONFIG.root_label);
  for (const key of Object.keys(DEFAULT_CONFIG.paths)) {
    config.paths[key] = asString(config.paths[key], DEFAULT_CONFIG.paths[key]);
  }
  config.exclusions = asStringArray(config.exclusions, DEFAULT_CONFIG.exclusions);
  config.text_extensions = asStringArray(
    config.text_extensions,
    DEFAULT_CONFIG.text_extensions
  ).map((suffix) => suffix.startsWith(".") ? suffix.toLowerCase() : "." + suffix.toLowerCase());
  config.max_file_bytes = asPositiveInteger(
    config.max_file_bytes,
    DEFAULT_CONFIG.max_file_bytes
  );
  config.paliers.p1_max = asPositiveInteger(
    config.paliers.p1_max,
    DEFAULT_CONFIG.paliers.p1_max
  );
  config.paliers.p2_max = asPositiveInteger(
    config.paliers.p2_max,
    DEFAULT_CONFIG.paliers.p2_max
  );
  config.paliers.p3_max = asPositiveInteger(
    config.paliers.p3_max,
    DEFAULT_CONFIG.paliers.p3_max
  );
  config.paliers.shard_from = asTier(
    config.paliers.shard_from,
    DEFAULT_CONFIG.paliers.shard_from
  );
  config.deltas.retention = asPositiveInteger(
    config.deltas.retention,
    DEFAULT_CONFIG.deltas.retention
  );
  config.thermal.hot_max_days = asPositiveInteger(
    config.thermal.hot_max_days,
    DEFAULT_CONFIG.thermal.hot_max_days
  );
  config.thermal.warm_max_days = asPositiveInteger(
    config.thermal.warm_max_days,
    DEFAULT_CONFIG.thermal.warm_max_days
  );
  config.ephemeral.ttl_days = asPositiveInteger(
    config.ephemeral.ttl_days,
    DEFAULT_CONFIG.ephemeral.ttl_days
  );
  config.canonical_dirs = asStringArray(
    config.canonical_dirs,
    DEFAULT_CONFIG.canonical_dirs
  );
  config.activity.active_paths = asStringArray(
    config.activity.active_paths,
    DEFAULT_CONFIG.activity.active_paths
  );
  config.activity.active_dir_prefixes = asStringArray(
    config.activity.active_dir_prefixes,
    DEFAULT_CONFIG.activity.active_dir_prefixes
  );
  return config;
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function findConfigAtRoot(root) {
  const defaultPath = join(root, VAULT_CONFIG_RELATIVE_PATH);
  if (await exists(defaultPath)) {
    return defaultPath;
  }
  try {
    const candidates = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && NUMBERED_DIRECTORY.test(entry.name)).map((entry) => join(root, entry.name, VAULT_CONFIG_FILENAME));
    for (const candidate of candidates.sort()) {
      if (await exists(candidate)) {
        return candidate;
      }
    }
  } catch {
    return void 0;
  }
  return void 0;
}
async function findVaultConfigPath(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    const configPath = await findConfigAtRoot(current);
    if (configPath) {
      return configPath;
    }
    const parent = dirname(current);
    if (parent === current) {
      return void 0;
    }
    current = parent;
  }
}
async function findVaultRoot(start = process.cwd()) {
  const configPath = await findVaultConfigPath(start);
  return configPath ? dirname(dirname(configPath)) : resolve(start);
}
async function loadConfig(root) {
  const vaultRoot = root ? resolve(root) : await findVaultRoot();
  const configPath = await findConfigAtRoot(vaultRoot) ?? join(vaultRoot, VAULT_CONFIG_RELATIVE_PATH);
  let parsed = {};
  try {
    const text = await readFile(configPath, "utf8");
    const value = parse(text);
    parsed = isRecord(value) ? value : {};
  } catch {
    parsed = {};
  }
  return normalizeConfig(deepMerge(DEFAULT_CONFIG, parsed));
}
function excludedParts(config) {
  return new Set(config.exclusions.map((part) => part.normalize("NFKD").toLowerCase()));
}
function palier(count, config) {
  if (count < config.paliers.p1_max) {
    return "P1";
  }
  if (count < config.paliers.p2_max) {
    return "P2";
  }
  if (count < config.paliers.p3_max) {
    return "P3";
  }
  return "P4";
}
function shardsEnabled(count, config) {
  const order = ["P1", "P2", "P3", "P4"];
  return order.indexOf(palier(count, config)) >= order.indexOf(config.paliers.shard_from);
}
function shardKey(recordPath, rootLabel) {
  const prefix = rootLabel + "/";
  const relative3 = recordPath.startsWith(prefix) ? recordPath.slice(prefix.length) : recordPath;
  const separator = relative3.indexOf("/");
  return separator === -1 ? "root" : relative3.slice(0, separator);
}

// src/core/catalog.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCatalogRecord(value) {
  return isRecord2(value) && typeof value.path === "string" && typeof value.kind === "string" && typeof value.domain === "string";
}
function recordsFromCatalog(value) {
  if (Array.isArray(value)) {
    return value.filter(isCatalogRecord);
  }
  if (isRecord2(value) && Array.isArray(value.records)) {
    return value.records.filter(isCatalogRecord);
  }
  return [];
}
function catalogEnvelopeFromValue(value) {
  if (!isRecord2(value) || !Array.isArray(value.records)) {
    return void 0;
  }
  const schemaVersion = value.schema_version;
  const generatedAt = value.generated_at;
  const rootLabel = value.root_label;
  if (typeof schemaVersion !== "number" || typeof generatedAt !== "string" || typeof rootLabel !== "string") {
    return void 0;
  }
  return {
    schema_version: schemaVersion,
    generated_at: generatedAt,
    root_label: rootLabel,
    records: value.records.filter(isCatalogRecord)
  };
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return void 0;
  }
}
async function readCatalogFile(path) {
  return recordsFromCatalog(await readJson(path));
}
async function readCatalogIndex(path) {
  const value = await readJson(path);
  if (!isRecord2(value) || !isRecord2(value.shards)) {
    return void 0;
  }
  if (typeof value.schema_version !== "number" || typeof value.generated_at !== "string" || typeof value.root_label !== "string" || typeof value.shard_count !== "number" || typeof value.total_docs !== "number") {
    return void 0;
  }
  return value;
}
async function loadCatalog(root, config, layers) {
  const aggregatePath = join(root, config.paths.catalog);
  if (!layers) {
    return readCatalogFile(aggregatePath);
  }
  const wanted = [...new Set(layers)];
  const index = await readCatalogIndex(join(root, config.paths.catalog_index));
  if (index) {
    const records = [];
    let loadedAny = false;
    for (const layer of wanted) {
      if (!Object.hasOwn(index.shards, layer)) {
        continue;
      }
      const shardRecords = await readCatalogFile(
        join(root, config.paths.catalog_shards, layer + ".json")
      );
      if (shardRecords.length > 0) {
        records.push(...shardRecords);
        loadedAny = true;
      }
    }
    if (loadedAny) {
      return records;
    }
  }
  const aggregate = await readCatalogFile(aggregatePath);
  const wantedSet = new Set(wanted);
  return aggregate.filter((record) => wantedSet.has(shardKey(record.path, config.root_label)));
}
var execFileAsync = promisify(execFile);
var DAY_MS = 864e5;
var FILENAME_DATE = /(20\d{2})-(\d{2})-(\d{2})/u;
function filenameDateTimestamp(relativePath2) {
  const match = FILENAME_DATE.exec(basename(relativePath2));
  if (!match) {
    return void 0;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? Math.floor(timestamp / 1e3) : void 0;
}
function resolveRename(path, forward) {
  const seen = /* @__PURE__ */ new Set();
  let current = path;
  while (forward.has(current) && !seen.has(current)) {
    seen.add(current);
    current = forward.get(current);
  }
  return current;
}
async function gitContentTimes(root) {
  try {
    const renameResult = await execFileAsync(
      "git",
      ["-C", root, "log", "-M", "--format=", "--name-status", "--diff-filter=R"],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const forward = /* @__PURE__ */ new Map();
    for (const line of renameResult.stdout.split(/\r?\n/u)) {
      if (!line.startsWith("R")) {
        continue;
      }
      const parts = line.split("	");
      const oldPath = parts[1];
      const newPath = parts[2];
      if (parts.length === 3 && oldPath && newPath) {
        forward.set(oldPath, newPath);
      }
    }
    const contentResult = await execFileAsync(
      "git",
      ["-C", root, "log", "-M", "--format=C%at", "--name-status", "--diff-filter=ACM"],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const times = /* @__PURE__ */ new Map();
    let currentTimestamp;
    for (const line of contentResult.stdout.split(/\r?\n/u)) {
      if (/^C\d+$/u.test(line)) {
        currentTimestamp = Number(line.slice(1));
        continue;
      }
      if (!line.trim() || currentTimestamp === void 0) {
        continue;
      }
      const path = line.split("	").at(-1);
      if (!path) {
        continue;
      }
      const resolved = resolveRename(path, forward);
      if (!times.has(resolved)) {
        times.set(resolved, currentTimestamp);
      }
    }
    return times;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function repoFloorTimestamp(times) {
  let floor;
  for (const timestamp of times.values()) {
    floor = floor === void 0 ? timestamp : Math.min(floor, timestamp);
  }
  return floor;
}
async function contentAgeDays(options) {
  const candidates = [];
  const gitTimestamp = options.gitTimes.get(options.relativePath);
  if (gitTimestamp !== void 0) {
    candidates.push(gitTimestamp * 1e3);
  }
  try {
    candidates.push((await stat(options.absolutePath)).mtimeMs);
  } catch {
  }
  if (candidates.length === 0) {
    return 0;
  }
  let ageTimestamp = Math.min(...candidates);
  const filenameTimestamp = filenameDateTimestamp(options.relativePath);
  const floor = options.floorTimestamp;
  if (gitTimestamp !== void 0 && floor !== void 0 && gitTimestamp <= floor + 3 * 86400 && filenameTimestamp !== void 0 && filenameTimestamp * 1e3 < ageTimestamp) {
    ageTimestamp = filenameTimestamp * 1e3;
  }
  const now = options.now ?? /* @__PURE__ */ new Date();
  return Math.max(0, (now.getTime() - ageTimestamp) / DAY_MS);
}
function isActive(relativePath2, activePaths, activeDirPrefixes) {
  if (activePaths.has(relativePath2)) {
    return true;
  }
  return [...activeDirPrefixes].some((prefix) => relativePath2.startsWith(prefix));
}
function activePathsFromConfig(config) {
  return {
    files: new Set(config.activity.active_paths),
    directories: new Set(config.activity.active_dir_prefixes)
  };
}
function thermalTier(ageDays, hasIncoming, lifecycle, active, config) {
  if (active || ageDays < config.thermal.hot_max_days) {
    return "hot";
  }
  if (ageDays > config.thermal.warm_max_days && !hasIncoming && lifecycle !== "master") {
    return "cold";
  }
  return "warm";
}
function isExpired(expires, now = /* @__PURE__ */ new Date()) {
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/u.test(expires)) {
    return false;
  }
  const expiry = /* @__PURE__ */ new Date(expires + "T00:00:00.000Z");
  if (Number.isNaN(expiry.getTime())) {
    return false;
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return expiry.getTime() < today;
}
var CASE_FOLD_REPLACEMENTS = {
  "\xDF": "ss",
  "\u03C2": "\u03C3"
};
function normalize(text) {
  const decomposed = text.normalize("NFKD").replace(new RegExp("\\p{Mark}", "gu"), "").toLowerCase();
  return Array.from(decomposed, (character) => CASE_FOLD_REPLACEMENTS[character] ?? character).join("");
}
function tokenize(text) {
  return normalize(text).match(/[a-z0-9_.-]+/g)?.filter((token) => token.length > 1) ?? [];
}
function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}
function countCodePoints(value) {
  return Array.from(value).length;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function decodeText(bytes) {
  if (bytes.subarray(0, 4096).includes(0)) {
    throw new UnicodeError("binary_null_byte");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "");
    return { bytes, text, encoding: "utf-8" };
  } catch {
    const text = new TextDecoder("iso-8859-1").decode(bytes);
    return { bytes, text, encoding: "latin-1" };
  }
}
var UnicodeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UnicodeError";
  }
};
function extractHeadings(text, limit = 6) {
  const headings = [];
  const matcher = /^(#{1,6})\s+(.+?)\s*$/gmu;
  for (const match of text.matchAll(matcher)) {
    const heading = match[2];
    if (heading) {
      headings.push(heading.trim());
    }
    if (headings.length >= limit) {
      break;
    }
  }
  return headings;
}
function extractLinks(text, limit = 50) {
  const links = [];
  const patterns = [/\[\[([^\]]+)\]\]/gmu, /\[[^\]]+\]\(([^)]+)\)/gmu];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim() ?? "";
      if (value && !links.includes(value)) {
        links.push(value);
      }
      if (links.length >= limit) {
        return links;
      }
    }
  }
  return links;
}
function extractSummary(text, headings, limit = 220) {
  const firstHeading = headings[0];
  if (firstHeading) {
    return firstHeading.slice(0, limit);
  }
  for (const line of text.split(/\r?\n/u)) {
    const compact = line.replace(/\s+/gu, " ").trim();
    if (compact) {
      return compact.slice(0, limit);
    }
  }
  return text.replace(/\s+/gu, " ").trim().slice(0, limit);
}

// src/core/gc.ts
var GC_PROPOSAL_SCHEMA_VERSION = 1;
function pathPrefix(rootLabel, relativePath2) {
  return `${rootLabel}/${toPosixPath(relativePath2).replace(/^\/+|\/+$/gu, "")}/`;
}
function proposalId(now) {
  return `gc-${now.toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}
function assertReviewableId(id) {
  if (!/^gc-[a-z0-9-]+$/u.test(id)) {
    throw new TypeError("GC proposal id is invalid.");
  }
}
function writeAtomic(path, content) {
  return (async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => void 0);
    }
  })();
}
function proposeGc(records, config, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const incoming = new Set(options.graph?.edges.map((edge) => edge.target) ?? []);
  const indexPrefix = pathPrefix(config.root_label, config.paths.index);
  const archivePrefix = pathPrefix(config.root_label, config.paths.archive);
  const candidates = records.flatMap((record) => {
    if (record.lifecycle === "master" || record.path.startsWith(indexPrefix) || record.path.startsWith(archivePrefix)) {
      return [];
    }
    if (record.lifecycle === "ephemeral" && isExpired(record.expires, now)) {
      return [{
        path: record.path,
        sha256: record.sha256,
        lifecycle: record.lifecycle,
        tier: record.tier,
        reason: "expired_ephemeral"
      }];
    }
    if (record.tier === "cold" && !incoming.has(record.path)) {
      return [{
        path: record.path,
        sha256: record.sha256,
        lifecycle: record.lifecycle,
        tier: record.tier,
        reason: "cold_unreferenced"
      }];
    }
    return [];
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema_version: GC_PROPOSAL_SCHEMA_VERSION,
    id: proposalId(now),
    created_at: now.toISOString(),
    candidates
  };
}
function reviewGcProposal(proposal, decision, reviewer, now = /* @__PURE__ */ new Date()) {
  assertReviewableId(proposal.id);
  if (!reviewer.trim()) {
    throw new TypeError("GC review requires a non-empty reviewer.");
  }
  return {
    ...proposal,
    candidates: proposal.candidates.map((candidate) => ({ ...candidate })),
    review: {
      decision,
      reviewer: reviewer.trim(),
      reviewed_at: now.toISOString()
    }
  };
}
async function applyReviewedGcProposal(root, config, proposal, currentRecords, now = /* @__PURE__ */ new Date()) {
  assertReviewableId(proposal.id);
  if (!proposal.review || proposal.review.decision !== "approved") {
    throw new Error("GC proposal must be explicitly reviewed and approved before apply.");
  }
  const currentByPath = new Map(
    currentRecords.map((record) => [record.path, record.sha256])
  );
  const candidates = proposal.candidates.map((candidate) => {
    const currentHash = currentByPath.get(candidate.path);
    const current = currentHash === void 0 ? "missing" : currentHash === candidate.sha256 ? "unchanged" : "changed";
    return { ...candidate, current };
  });
  const reportRelativePath = join(
    config.paths.index,
    "gc-proposals",
    `${proposal.id}.applied.json`
  );
  const result = {
    schema_version: GC_PROPOSAL_SCHEMA_VERSION,
    proposal_id: proposal.id,
    applied_at: now.toISOString(),
    review: { ...proposal.review },
    candidates,
    deleted_count: 0,
    report_path: toPosixPath(reportRelativePath)
  };
  await writeAtomic(
    join(root, reportRelativePath),
    `${JSON.stringify(result, null, 2)}
`
  );
  return result;
}

// src/core/types.ts
var SCHEMA_VERSION = 1;

// src/core/graph.ts
function stripRootLabel(recordPath, rootLabel) {
  const prefix = rootLabel + "/";
  return recordPath.startsWith(prefix) ? recordPath.slice(prefix.length) : recordPath;
}
function cleanLinkTarget(link) {
  let value = link.split("#", 1)[0]?.trim() ?? "";
  if (!value) {
    return void 0;
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:") || lower.startsWith("file:") || value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value)) {
    return void 0;
  }
  if (!/[a-z0-9]/iu.test(value)) {
    return void 0;
  }
  value = value.replace(/^(\.\/|\.\.\/)+/u, "").replace(/^\/+/u, "");
  return value || void 0;
}
function withoutMarkdownExtension(value) {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}
function stem(value) {
  const name = basename$1(value);
  const suffix = extname$1(name);
  return suffix ? name.slice(0, -suffix.length) : name;
}
function buildGraph(records, rootLabel, now = /* @__PURE__ */ new Date()) {
  const byRelativePath = /* @__PURE__ */ new Map();
  const byStem = /* @__PURE__ */ new Map();
  const domainByPath = /* @__PURE__ */ new Map();
  for (const record of records) {
    const relative3 = normalize(stripRootLabel(record.path, rootLabel));
    byRelativePath.set(relative3, record.path);
    byRelativePath.set(withoutMarkdownExtension(relative3), record.path);
    const key = normalize(stem(relative3));
    byStem.set(key, [...byStem.get(key) ?? [], record.path]);
    domainByPath.set(record.path, record.domain);
  }
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  for (const record of records) {
    for (const link of record.links) {
      const cleaned = cleanLinkTarget(link);
      if (!cleaned) {
        continue;
      }
      const normalizedTarget = normalize(cleaned);
      let target = byRelativePath.get(normalizedTarget) ?? byRelativePath.get(withoutMarkdownExtension(normalizedTarget));
      if (!target) {
        const candidates = byStem.get(normalize(stem(cleaned))) ?? [];
        if (candidates.length === 1) {
          target = candidates[0];
        } else if (candidates.length > 1) {
          const sameDomain = candidates.filter(
            (candidate) => domainByPath.get(candidate) === record.domain
          );
          if (sameDomain.length === 1) {
            target = sameDomain[0];
          }
        }
      }
      const key = record.path + "\0" + (target ?? "");
      if (target && target !== record.path && !seen.has(key)) {
        edges.push({ source: record.path, target, kind: "link" });
        seen.add(key);
      }
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root_label: rootLabel,
    nodes: records.map((record) => ({
      path: record.path,
      domain: record.domain,
      tags: [...record.tags]
    })),
    edges
  };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord3(value)) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}
function prettyJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = path + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}
function formatDeltaTimestamp(now) {
  return now.toISOString().replace(/[:.]/gu, "").replace("T", "_").replace("Z", "");
}
function renderDeltaNote(rootLabel, delta, now) {
  const section = (title, paths) => {
    const lines2 = ["## " + title, ""];
    if (paths.length === 0) {
      lines2.push("- none");
    } else {
      for (const path of paths.slice(0, 80)) {
        lines2.push("- " + path);
      }
      if (paths.length > 80) {
        lines2.push("- " + String(paths.length - 80) + " more");
      }
    }
    lines2.push("");
    return lines2;
  };
  const lines = [
    "# Scan delta",
    "",
    "Generated: " + now.toISOString(),
    "Root: " + rootLabel + "/",
    "",
    "## Counts",
    "",
    "- added: " + String(delta.added_count),
    "- modified: " + String(delta.modified_count),
    "- removed: " + String(delta.removed_count),
    "",
    ...section("Added", delta.added),
    ...section("Modified", delta.modified),
    ...section("Removed", delta.removed)
  ];
  return lines.join("\n");
}
async function previousShardNames(path) {
  const value = await readJson(path);
  if (!isRecord3(value) || !isRecord3(value.shards)) {
    return /* @__PURE__ */ new Set();
  }
  return new Set(Object.keys(value.shards));
}
async function writeShards(root, config, catalog, now) {
  const shardDirectory = join(root, config.paths.catalog_shards);
  const indexPath = join(root, config.paths.catalog_index);
  const priorShards = await previousShardNames(indexPath);
  const groups = /* @__PURE__ */ new Map();
  for (const record of catalog.records) {
    const key = shardKey(record.path, catalog.root_label);
    groups.set(key, [...groups.get(key) ?? [], record]);
  }
  await mkdir(shardDirectory, { recursive: true });
  const currentNames = new Set(groups.keys());
  const existingEntries = await readdir(shardDirectory, { withFileTypes: true });
  const existingNames = new Set(
    existingEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  );
  const missingRecreated = [...priorShards].filter((name) => currentNames.has(name) && !existingNames.has(name + ".json")).sort();
  for (const entry of existingEntries) {
    if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "catalog_index.json" && !currentNames.has(entry.name.slice(0, -5))) {
      await unlink(join(shardDirectory, entry.name));
    }
  }
  const shards = {};
  for (const [layer, records] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedRecords = [...records].sort(
      (left, right) => right.read_priority - left.read_priority || left.path.localeCompare(right.path)
    );
    const payload = {
      schema_version: SCHEMA_VERSION,
      generated_at: now.toISOString(),
      root_label: catalog.root_label,
      records: sortedRecords
    };
    const content = prettyJson(payload);
    await writeAtomically(join(shardDirectory, layer + ".json"), content);
    shards[layer] = {
      layer,
      docs: sortedRecords.length,
      sha256: sha256(canonicalJson(payload))
    };
  }
  const index = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root_label: catalog.root_label,
    shard_count: Object.keys(shards).length,
    total_docs: catalog.records.length,
    shards
  };
  await writeAtomically(indexPath, prettyJson(index));
  return {
    shards_written: Object.keys(shards).length,
    missing_recreated: missingRecreated
  };
}
async function writeIndexArtifacts(root, config, scan, options = {}) {
  const now = options.now ?? new Date(scan.catalog.generated_at);
  await writeAtomically(join(root, config.paths.catalog), prettyJson(scan.catalog));
  await writeAtomically(join(root, config.paths.graph), prettyJson(scan.graph));
  let freshness = scan.freshness;
  if (scan.freshness.sharded) {
    const shards = await writeShards(root, config, scan.catalog, now);
    freshness = { ...freshness, shards };
  }
  let deltaPath;
  if (options.writeDelta !== false) {
    const filename = "scan-delta-" + formatDeltaTimestamp(now) + ".md";
    deltaPath = join(config.paths.deltas, filename);
    const fullPath = join(root, deltaPath);
    await writeAtomically(
      fullPath,
      renderDeltaNote(config.root_label, scan.delta, now)
    );
    const deltaDirectory = join(root, config.paths.deltas);
    const deltas = (await readdir(deltaDirectory)).filter((entry) => /^scan-delta-\d{4}-\d{2}-\d{2}_\d{6}\.md$/u.test(entry)).sort();
    for (const stale of deltas.slice(0, Math.max(0, deltas.length - config.deltas.retention))) {
      await unlink(join(deltaDirectory, stale));
    }
    freshness = {
      ...freshness,
      delta_note: config.root_label + "/" + deltaPath.replace(/\\/gu, "/")
    };
  }
  await writeAtomically(join(root, config.paths.freshness), prettyJson(freshness));
  return deltaPath ? { freshness, delta_path: deltaPath } : { freshness };
}

// src/core/health.ts
var DEFAULT_MAX_FRESHNESS_AGE_MS = 24 * 60 * 60 * 1e3;
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asFreshness(value) {
  if (!isRecord4(value)) {
    return void 0;
  }
  if (typeof value.generated_at !== "string" || typeof value.source_count !== "number" || typeof value.catalog_sha256 !== "string" || typeof value.sharded !== "boolean") {
    return void 0;
  }
  return value;
}
function asCatalogIndex(value) {
  if (!isRecord4(value) || !isRecord4(value.shards)) {
    return void 0;
  }
  if (typeof value.total_docs !== "number" || typeof value.shard_count !== "number" || typeof value.root_label !== "string") {
    return void 0;
  }
  return value;
}
async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function checkShardIntegrity(root, config, catalogRecords) {
  const checks = [];
  const indexPath = join(root, config.paths.catalog_index);
  const catalogIndex = asCatalogIndex(await readJson(indexPath));
  if (!catalogIndex) {
    return [{
      name: "shards",
      severity: "error",
      detail: "Shard index is missing or invalid."
    }];
  }
  const shardEntries = Object.entries(catalogIndex.shards).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  if (catalogIndex.shard_count !== shardEntries.length) {
    checks.push({
      name: "shards",
      severity: "error",
      detail: "Shard index count does not match its metadata entries."
    });
  }
  let totalDocs = 0;
  for (const [name, metadata] of shardEntries) {
    if (!isRecord4(metadata) || typeof metadata.docs !== "number" || typeof metadata.sha256 !== "string") {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard metadata is invalid."
      });
      continue;
    }
    totalDocs += metadata.docs;
    const path = join(root, config.paths.catalog_shards, `${name}.json`);
    const value = await readJson(path);
    const envelope = catalogEnvelopeFromValue(value);
    if (!envelope) {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard file is missing or invalid."
      });
      continue;
    }
    if (envelope.records.length !== metadata.docs) {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard record count does not match metadata."
      });
    }
    if (sha256(canonicalJson(value)) !== metadata.sha256) {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard checksum does not match metadata."
      });
    }
  }
  if (totalDocs !== catalogIndex.total_docs || totalDocs !== catalogRecords) {
    checks.push({
      name: "shards",
      severity: "error",
      detail: "Shard document totals do not match the aggregate catalog."
    });
  }
  if (checks.length === 0) {
    checks.push({
      name: "shards",
      severity: "ok",
      detail: `${shardEntries.length} shard(s) match the aggregate catalog.`
    });
  }
  return checks;
}
async function checkVaultHealth(root, config, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const maxFreshnessAgeMs = options.maxFreshnessAgeMs ?? DEFAULT_MAX_FRESHNESS_AGE_MS;
  const checks = [];
  for (const directory of config.canonical_dirs) {
    const present = await directoryExists(join(root, directory));
    checks.push({
      name: `directory:${directory}`,
      severity: present ? "ok" : "error",
      detail: present ? "Present." : "Missing canonical directory."
    });
  }
  const catalogPath = join(root, config.paths.catalog);
  const freshnessPath = join(root, config.paths.freshness);
  const catalog = catalogEnvelopeFromValue(await readJson(catalogPath));
  const freshness = asFreshness(await readJson(freshnessPath));
  const indexAvailable = Boolean(catalog && freshness);
  let stale = !indexAvailable;
  if (!catalog) {
    checks.push({ name: "catalog", severity: "error", detail: "Catalog is missing or invalid." });
  }
  if (!freshness) {
    checks.push({ name: "freshness", severity: "error", detail: "Freshness index is missing or invalid." });
  }
  if (catalog && freshness) {
    const generatedAt = new Date(freshness.generated_at);
    const age = now.getTime() - generatedAt.getTime();
    if (Number.isNaN(generatedAt.getTime())) {
      stale = true;
      checks.push({ name: "freshness", severity: "error", detail: "Freshness timestamp is invalid." });
    } else if (age > maxFreshnessAgeMs) {
      stale = true;
      checks.push({ name: "freshness", severity: "warning", detail: "Index freshness is stale." });
    } else {
      checks.push({ name: "freshness", severity: "ok", detail: "Index freshness is current." });
    }
    if (freshness.source_count !== catalog.records.length) {
      stale = true;
      checks.push({ name: "catalog", severity: "error", detail: "Catalog count does not match freshness." });
    }
    if (freshness.catalog_sha256 !== sha256(canonicalJson(catalog.records))) {
      stale = true;
      checks.push({ name: "catalog", severity: "error", detail: "Catalog checksum does not match freshness." });
    } else {
      checks.push({ name: "catalog", severity: "ok", detail: "Catalog matches freshness." });
    }
    if (freshness.sharded) {
      checks.push(...await checkShardIntegrity(root, config, catalog.records.length));
    } else {
      const shardIndexPath = join(root, config.paths.catalog_index);
      const shardIndexPresent = await fileExists(shardIndexPath);
      checks.push({
        name: "shards",
        severity: shardIndexPresent ? "warning" : "ok",
        detail: shardIndexPresent ? "Shard index is present while sharding is disabled." : "Sharding is disabled."
      });
    }
  }
  return {
    healthy: checks.every((check) => check.severity !== "error"),
    stale,
    index_available: indexAvailable,
    checked_at: now.toISOString(),
    checks
  };
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function safeName(value) {
  const compact = value.normalize("NFKD").replace(new RegExp("\\p{Mark}", "gu"), "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return compact || "import";
}
function batchIdentifier(now, supplied) {
  if (supplied && /^[a-z0-9][a-z0-9_-]*$/u.test(supplied)) {
    return supplied;
  }
  return `${now.toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}
function stringParts(value) {
  return Array.isArray(value) ? value.filter((part) => typeof part === "string" && part.trim().length > 0) : [];
}
function conversationNodeText(node) {
  const message = node.message;
  if (!isRecord5(message)) {
    return void 0;
  }
  const role = isRecord5(message.author) ? nonEmptyString(message.author.role) : void 0;
  const content = isRecord5(message.content) ? message.content : void 0;
  const parts = content ? stringParts(content.parts) : [];
  if (parts.length === 0) {
    return void 0;
  }
  return `## ${role ?? "message"}

${parts.join("\n")}`;
}
function childIds(node) {
  return Array.isArray(node.children) ? node.children.filter((child) => typeof child === "string").sort() : [];
}
function transcriptFromMapping(mapping) {
  const referenced = /* @__PURE__ */ new Set();
  for (const node of Object.values(mapping)) {
    if (isRecord5(node)) {
      for (const child of childIds(node)) {
        referenced.add(child);
      }
    }
  }
  const roots = Object.keys(mapping).filter((id) => !referenced.has(id)).sort();
  const visited = /* @__PURE__ */ new Set();
  const parts = [];
  const visit = (id) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const node = mapping[id];
    if (!isRecord5(node)) {
      return;
    }
    const text = conversationNodeText(node);
    if (text) {
      parts.push(text);
    }
    for (const child of childIds(node)) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  for (const id of Object.keys(mapping).sort()) {
    visit(id);
  }
  return parts.join("\n\n");
}
function conversationObjects(value) {
  if (Array.isArray(value)) {
    return value.filter(isRecord5);
  }
  if (!isRecord5(value)) {
    return [];
  }
  if (isRecord5(value.mapping)) {
    return [value];
  }
  if (Array.isArray(value.conversations)) {
    return value.conversations.filter(isRecord5);
  }
  return [];
}
function extractChatGptConversations(value) {
  return conversationObjects(value).flatMap((conversation, index) => {
    if (!isRecord5(conversation.mapping)) {
      return [];
    }
    const body = transcriptFromMapping(conversation.mapping);
    if (!body) {
      return [];
    }
    return [{
      title: nonEmptyString(conversation.title) ?? `Conversation ${index + 1}`,
      body,
      kind: "conversation"
    }];
  });
}
function extractIngestDocuments(fileName, content) {
  const extension = extname(fileName).toLowerCase();
  const title = basename(fileName, extension) || "Imported document";
  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    return content.trim() ? [{ title, body: content, kind: "text" }] : [];
  }
  if (extension !== ".json") {
    return [];
  }
  const value = JSON.parse(content);
  const conversations = extractChatGptConversations(value);
  if (conversations.length > 0) {
    return conversations;
  }
  return [{
    title,
    body: JSON.stringify(value, null, 2),
    kind: "json"
  }];
}
function renderBrief(document, archivePath, now) {
  const headings = extractHeadings(document.body);
  const summary = extractSummary(document.body, headings, 900) || "Imported content.";
  const extract = document.body.trim().slice(0, 4e3);
  return [
    "---",
    "lifecycle: working",
    `source: ${archivePath}`,
    `ingested_at: ${now.toISOString()}`,
    "---",
    `# ${document.title.replace(/[\r\n]+/gu, " ")}`,
    "",
    summary,
    "",
    "## Extract",
    "",
    extract,
    ""
  ].join("\n");
}
async function writeAtomically2(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
async function inboxFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await inboxFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}
async function ingestInbox(root, config, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const batch = batchIdentifier(now, options.batchId);
  const inboxRoot = join(root, config.paths.inbox);
  const report = {
    imported: [],
    failures: [],
    ignored: [],
    inbox_cleared: 0
  };
  for (const sourcePath of await inboxFiles(inboxRoot)) {
    const relativeSourcePath = toPosixPath(relative(inboxRoot, sourcePath));
    const extension = extname(sourcePath).toLowerCase();
    if (![".txt", ".md", ".markdown", ".json"].includes(extension)) {
      report.ignored.push(relativeSourcePath);
      continue;
    }
    try {
      const bytes = await readFile(sourcePath);
      const content = bytes.toString("utf8");
      const documents = extractIngestDocuments(sourcePath, content);
      if (documents.length === 0) {
        report.ignored.push(relativeSourcePath);
        continue;
      }
      const archiveRelativePath = toPosixPath(join(
        config.paths.archive,
        "imports",
        batch,
        relativeSourcePath
      ));
      await writeAtomically2(join(root, archiveRelativePath), bytes);
      const sourceStem = safeName(basename(sourcePath, extension));
      const sourceFingerprint = sha256(relativeSourcePath).slice(0, 12);
      const briefPaths = [];
      for (const [index, document] of documents.entries()) {
        const suffix = documents.length === 1 ? "" : `-${String(index + 1).padStart(3, "0")}`;
        const briefRelativePath = toPosixPath(join(
          config.paths.memory,
          "briefs",
          batch,
          `${sourceStem}-${sourceFingerprint}${suffix}.brief.md`
        ));
        await writeAtomically2(
          join(root, briefRelativePath),
          renderBrief(document, archiveRelativePath, now)
        );
        briefPaths.push(briefRelativePath);
      }
      await unlink(sourcePath);
      report.imported.push({
        source_path: relativeSourcePath,
        archive_path: archiveRelativePath,
        brief_paths: briefPaths
      });
      report.inbox_cleared += 1;
    } catch (error) {
      report.failures.push({
        source_path: relativeSourcePath,
        error: error instanceof Error ? error.message : "Unknown ingest failure."
      });
    }
  }
  return report;
}
var RAW_QUERY_TERMS = [
  "source",
  "transcript",
  "citation",
  "exact",
  "audit",
  "verify",
  "evidence"
];
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asStringArray2(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function parseRoute(value) {
  if (!isRecord6(value)) {
    return {};
  }
  const route = {
    triggers: asStringArray2(value.triggers),
    read_order: asStringArray2(value.read_order),
    deep_sources: value.deep_sources === true
  };
  if (typeof value.intent === "string") {
    route.intent = value.intent;
  }
  if (typeof value.max_files === "number" && value.max_files > 0) {
    route.max_files = Math.floor(value.max_files);
  }
  return route;
}
function parseRoutingDocument(value) {
  if (!isRecord6(value)) {
    return { always_read: [], routes: {} };
  }
  const alwaysReadValue = isRecord6(value.always_read) ? value.always_read.files : value.always_read;
  const routes = {};
  if (isRecord6(value.routes)) {
    for (const [name, route] of Object.entries(value.routes)) {
      routes[name] = parseRoute(route);
    }
  }
  return {
    always_read: asStringArray2(alwaysReadValue),
    routes
  };
}
async function loadRouting(root, config) {
  try {
    return parseRoutingDocument(parse(await readFile(join(root, config.paths.routing), "utf8")));
  } catch {
    return { always_read: [], routes: {} };
  }
}
function candidateLayers(route, alwaysRead) {
  const layers = /* @__PURE__ */ new Set();
  for (const entry of [...route.read_order ?? [], ...alwaysRead]) {
    const separator = entry.indexOf("/");
    layers.add(separator === -1 ? "root" : entry.slice(0, separator));
  }
  return layers.size > 0 ? [...layers].sort() : void 0;
}
function scoreRoute(query, route) {
  const normalizedQuery = normalize(query);
  const queryTokens = new Set(tokenize(query));
  let score = 0;
  for (const trigger of route.triggers ?? []) {
    const normalizedTrigger = normalize(trigger);
    const triggerTokens = new Set(tokenize(trigger));
    if (normalizedTrigger && normalizedQuery.includes(normalizedTrigger)) {
      score += 8 + triggerTokens.size;
    } else {
      let overlap = 0;
      for (const token of triggerTokens) {
        if (queryTokens.has(token)) {
          overlap += 1;
        }
      }
      score += overlap * 2;
    }
  }
  return score;
}
function chooseRoute(query, routes) {
  const choices = Object.entries(routes).map(([name, route]) => ({ name, route, score: scoreRoute(query, route) })).sort(
    (left, right) => right.score - left.score || Number(left.name === "default") - Number(right.name === "default") || left.name.localeCompare(right.name)
  );
  const best = choices[0] ?? { name: "default", route: {}, score: 0 };
  if (best.score <= 0 && routes.default) {
    return { name: "default", route: routes.default, score: 0 };
  }
  return best;
}
function pathWithoutRoot(recordPath) {
  const separator = recordPath.indexOf("/");
  return separator === -1 ? recordPath : recordPath.slice(separator + 1);
}
function scoreRecord(query, route, record) {
  const normalizedQuery = normalize(query);
  const wantsRaw = RAW_QUERY_TERMS.some((term) => normalizedQuery.includes(term));
  if (record.kind === "raw_source" && !route.deep_sources && !wantsRaw) {
    return -999;
  }
  const relativePath2 = normalize(pathWithoutRoot(record.path));
  const queryTokens = new Set(tokenize(query));
  const summary = normalize(record.summary);
  const tags = record.tags.map(normalize);
  const headings = normalize(record.headings.join(" "));
  let score = Math.floor(record.read_priority / 10);
  for (const [index, target] of (route.read_order ?? []).entries()) {
    const normalizedTarget = normalize(target);
    if (relativePath2 === normalizedTarget) {
      score += 120 - index;
    } else if (relativePath2.startsWith(normalizedTarget.replace(/\/$/u, "") + "/")) {
      score += 90 - index;
    } else if (relativePath2.includes(normalizedTarget)) {
      score += 45 - index;
    }
  }
  const haystack = relativePath2 + " " + summary + " " + tags.join(" ") + " " + headings;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 4;
    }
  }
  if (record.kind === "raw_source" && !route.deep_sources) {
    score -= 30;
  }
  return score;
}
function selectRecords(query, route, catalog) {
  const maxFiles = route.max_files ?? 5;
  const scored = catalog.map((record) => ({ record, score: scoreRecord(query, route, record) })).filter((item) => item.score > 0).sort(
    (left, right) => right.score - left.score || right.record.read_priority - left.record.read_priority || left.record.path.localeCompare(right.record.path)
  );
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of scored) {
    if (seen.has(item.record.path)) {
      continue;
    }
    selected.push({ ...item.record, route_score: item.score });
    seen.add(item.record.path);
    if (selected.length >= maxFiles) {
      break;
    }
  }
  return selected;
}
function baselineRecords(paths, catalog) {
  const byRelativePath = new Map(catalog.map((record) => [pathWithoutRoot(record.path), record]));
  return paths.map((path, index) => {
    const record = byRelativePath.get(path);
    if (record) {
      return { ...record, route_score: 1e3 - index, baseline: true };
    }
    return {
      path,
      layer: "root",
      kind: "baseline",
      domain: "general",
      lifecycle: "working",
      tags: [],
      summary: "Baseline file declared by routing configuration.",
      headings: [],
      links: [],
      sha256: "",
      size: 0,
      token_estimate: 0,
      read_priority: 0,
      source_state: "configured",
      tier: "warm",
      route_score: 1e3 - index,
      baseline: true
    };
  });
}
function presentRecord(record) {
  return {
    path: record.path,
    kind: record.kind,
    domain: record.domain,
    size: record.size,
    read_priority: record.read_priority,
    route_score: record.route_score,
    baseline: record.baseline ?? false,
    summary: record.summary
  };
}
function routeRequest(query, routing, catalog) {
  const selectedRoute = chooseRoute(query, routing.routes);
  const baseline = baselineRecords(routing.always_read, catalog);
  const selected = selectRecords(query, selectedRoute.route, catalog);
  const seen = new Set(baseline.map((record) => record.path));
  const files = [
    ...baseline,
    ...selected.filter((record) => !seen.has(record.path))
  ];
  const layers = candidateLayers(selectedRoute.route, routing.always_read);
  return {
    query,
    route: selectedRoute.name,
    route_score: selectedRoute.score,
    intent: selectedRoute.route.intent ?? "",
    always_read: routing.always_read,
    read_order: selectedRoute.route.read_order ?? [],
    max_files: selectedRoute.route.max_files ?? 5,
    deep_sources: selectedRoute.route.deep_sources ?? false,
    budget: {
      files: files.length,
      read_bytes: files.reduce((total, record) => total + record.size, 0),
      read_tokens: files.reduce((total, record) => total + record.token_estimate, 0),
      layers_loaded: layers ?? "aggregate",
      catalog_docs_scored: catalog.length
    },
    files: files.map(presentRecord)
  };
}
async function routeVault(root, config, query) {
  const routing = await loadRouting(root, config);
  const selectedRoute = chooseRoute(query, routing.routes);
  const catalog = await loadCatalog(
    root,
    config,
    candidateLayers(selectedRoute.route, routing.always_read)
  );
  return routeRequest(query, routing, catalog);
}

// src/core/frontmatter.ts
var LIFECYCLES = /* @__PURE__ */ new Set([
  "master",
  "working",
  "ephemeral",
  "data"
]);
function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) {
    return { frontmatter: void 0, body: text };
  }
  const frontmatter = {};
  const block = match[1] ?? "";
  for (const line of block.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key) {
      frontmatter[key] = line.slice(separator + 1).trim();
    }
  }
  return { frontmatter, body: text.slice(match[0].length) };
}
function readLifecycleFromText(text) {
  const lifecycle = splitFrontmatter(text).frontmatter?.lifecycle;
  return lifecycle && LIFECYCLES.has(lifecycle) ? lifecycle : void 0;
}
function readExpiresFromText(text) {
  return splitFrontmatter(text).frontmatter?.expires;
}

// src/core/scan.ts
var LOADER_NAMES = /* @__PURE__ */ new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
var TOOL_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".sh"]);
function relativePath(root, path) {
  return toPosixPath(relative(root, path));
}
function projectPath(rootLabel, relativeFilePath) {
  return rootLabel + "/" + relativeFilePath;
}
function topSegment(path) {
  return path.split("/", 1)[0] ?? "";
}
function configTopSegment(path) {
  return topSegment(toPosixPath(path));
}
function inferLayer(relativeFilePath, config) {
  const top = topSegment(relativeFilePath);
  if (top === configTopSegment(config.paths.index)) {
    return "index";
  }
  if (top === configTopSegment(config.paths.inbox)) {
    return "inbox";
  }
  if (top === configTopSegment(config.paths.memory)) {
    return "memory";
  }
  if (top === configTopSegment(config.paths.contexts)) {
    return "context";
  }
  if (top === configTopSegment(config.paths.skills)) {
    return "skill";
  }
  if (top === configTopSegment(config.paths.sources)) {
    return "source";
  }
  if (top === configTopSegment(config.paths.outputs)) {
    return "output";
  }
  if (top === configTopSegment(config.paths.engine)) {
    return "engine";
  }
  if (top === configTopSegment(config.paths.archive)) {
    return "archive";
  }
  return "root";
}
function inferDomain(relativeFilePath, layer, config) {
  const memoryPreferences = toPosixPath(config.paths.memory).replace(/\/$/u, "") + "/preferences/";
  if (relativeFilePath.startsWith(toPosixPath(config.paths.index).replace(/\/$/u, "") + "/")) {
    return "brain";
  }
  if (relativeFilePath.startsWith(memoryPreferences)) {
    return "user_preferences";
  }
  if (layer === "source") {
    return "source";
  }
  return "general";
}
function inferKind(relativeFilePath, suffix, layer) {
  const name = relativeFilePath.split("/").at(-1) ?? relativeFilePath;
  if (LOADER_NAMES.has(name)) {
    return "loader";
  }
  if (name === "_index.md") {
    return "index";
  }
  if (name.endsWith(".brief.md")) {
    return "brief";
  }
  if (layer === "source") {
    return "raw_source";
  }
  if (TOOL_EXTENSIONS.has(suffix)) {
    return "tool";
  }
  if ([".json", ".yaml", ".yml", ".toml"].includes(suffix)) {
    return "config";
  }
  if (suffix === ".md") {
    return "note";
  }
  return "text";
}
function inferTags(text, domain, layer) {
  const tags = /* @__PURE__ */ new Set();
  if (domain !== "general") {
    tags.add(domain);
  }
  if (layer !== "root") {
    tags.add(layer);
  }
  for (const match of text.matchAll(/(?<!\w)#([A-Za-z0-9_-]+)/gu)) {
    const tag = match[1];
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return [...tags].sort();
}
function inferPriority(relativeFilePath, kind, layer, config) {
  const name = relativeFilePath.split("/").at(-1) ?? relativeFilePath;
  if (LOADER_NAMES.has(name)) {
    return 100;
  }
  if (relativeFilePath === toPosixPath(config.paths.routing)) {
    return 92;
  }
  if (kind === "index") {
    return 82;
  }
  if (kind === "brief") {
    return 74;
  }
  if (kind === "tool") {
    return 56;
  }
  if (layer === "memory" || layer === "context" || layer === "skill") {
    return 55;
  }
  if (layer === "source") {
    return 18;
  }
  return 35;
}
function inferSourceState(kind, layer) {
  if (kind === "index" || kind === "brief" || kind === "loader") {
    return "curated";
  }
  if (layer === "source") {
    return "raw";
  }
  if (layer === "index") {
    return "brain";
  }
  if (kind === "tool") {
    return "tool";
  }
  return "working";
}
function inferLifecycle(text, suffix) {
  if (suffix !== ".md") {
    return { lifecycle: "data" };
  }
  const lifecycle = readLifecycleFromText(text) ?? "working";
  const expires = readExpiresFromText(text);
  return expires ? { lifecycle, expires } : { lifecycle };
}
function generatedPaths(config) {
  return /* @__PURE__ */ new Set([
    toPosixPath(config.paths.catalog),
    toPosixPath(config.paths.graph),
    toPosixPath(config.paths.freshness),
    toPosixPath(config.paths.catalog_index)
  ]);
}
function isGeneratedPath(relativeFilePath, config) {
  const normalized = toPosixPath(relativeFilePath);
  if (generatedPaths(config).has(normalized)) {
    return true;
  }
  const shardPrefix = toPosixPath(config.paths.catalog_shards).replace(/\/$/u, "") + "/";
  const deltaPrefix = toPosixPath(config.paths.deltas).replace(/\/$/u, "") + "/";
  return normalized.startsWith(shardPrefix) || normalized.startsWith(deltaPrefix);
}
function hasExcludedPart(relativeFilePath, excluded) {
  return relativeFilePath.split("/").map((part) => normalize(part)).some((part) => excluded.has(part));
}
async function walkFiles(root, current, excluded) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(current, entry.name);
    const relativeFilePath = relativePath(root, absolutePath);
    if (hasExcludedPart(relativeFilePath, excluded)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, absolutePath, excluded));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}
async function shouldSkip(root, absolutePath, config, maxFileBytes, excluded) {
  const relativeFilePath = relativePath(root, absolutePath);
  if (isGeneratedPath(relativeFilePath, config)) {
    return "generated_index";
  }
  if (hasExcludedPart(relativeFilePath, excluded)) {
    return "excluded";
  }
  try {
    const metadata = await stat(absolutePath);
    if (metadata.size > maxFileBytes) {
      return "oversize";
    }
  } catch {
    return "stat_error";
  }
  const suffix = extname(relativeFilePath).toLowerCase();
  if (suffix && !config.text_extensions.includes(suffix)) {
    return "unrecognized_suffix";
  }
  return void 0;
}
async function buildRecord(root, absolutePath, config) {
  const bytes = await readFile(absolutePath);
  const decoded = decodeText(bytes);
  const relativeFilePath = relativePath(root, absolutePath);
  const suffix = extname(relativeFilePath).toLowerCase();
  const layer = inferLayer(relativeFilePath, config);
  const domain = inferDomain(relativeFilePath, layer, config);
  const kind = inferKind(relativeFilePath, suffix, layer);
  const headings = extractHeadings(decoded.text);
  const lifecycle = inferLifecycle(decoded.text, suffix);
  const record = {
    path: projectPath(config.root_label, relativeFilePath),
    layer,
    domain,
    kind,
    lifecycle: lifecycle.lifecycle,
    tags: inferTags(decoded.text, domain, layer),
    summary: extractSummary(decoded.text, headings) || "(" + kind + ") " + relativeFilePath,
    headings,
    links: extractLinks(decoded.text),
    sha256: sha256(bytes),
    size: bytes.length,
    token_estimate: Math.max(1, Math.floor(countCodePoints(decoded.text) / 4)),
    read_priority: inferPriority(relativeFilePath, kind, layer, config),
    source_state: inferSourceState(kind, layer),
    tier: "warm"
  };
  if (lifecycle.expires) {
    record.expires = lifecycle.expires;
  }
  return record;
}
function computeDelta(previousRecords, records) {
  const previous = new Map(previousRecords.map((record) => [record.path, record.sha256]));
  const current = new Map(records.map((record) => [record.path, record.sha256]));
  const added = [...current.keys()].filter((path) => !previous.has(path)).sort();
  const removed = [...previous.keys()].filter((path) => !current.has(path)).sort();
  const modified = [...current.keys()].filter((path) => previous.has(path) && previous.get(path) !== current.get(path)).sort();
  return {
    added_count: added.length,
    removed_count: removed.length,
    modified_count: modified.length,
    added,
    removed,
    modified
  };
}
function countBy(records, field) {
  const counts = {};
  for (const record of records) {
    const value = record[field];
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
async function scanVault(root, config, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const excluded = excludedParts(config);
  const maxFileBytes = options.maxFileBytes ?? config.max_file_bytes;
  const skipped = {};
  const records = [];
  for (const absolutePath of await walkFiles(root, root, excluded)) {
    const reason = await shouldSkip(root, absolutePath, config, maxFileBytes, excluded);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    try {
      records.push(await buildRecord(root, absolutePath, config));
    } catch (error) {
      const name = error instanceof UnicodeError ? error.name : "read_error";
      skipped[name] = (skipped[name] ?? 0) + 1;
    }
  }
  records.sort(
    (left, right) => right.read_priority - left.read_priority || left.path.localeCompare(right.path)
  );
  const graph = buildGraph(records, config.root_label, now);
  const incoming = new Set(graph.edges.map((edge) => edge.target));
  const gitTimes = options.gitTimes ?? await gitContentTimes(root);
  const floorTimestamp = repoFloorTimestamp(gitTimes);
  const active = activePathsFromConfig(config);
  for (const record of records) {
    const relativeFilePath = record.path.slice((config.root_label + "/").length);
    const ageDays = await contentAgeDays({
      relativePath: relativeFilePath,
      absolutePath: join(root, relativeFilePath),
      gitTimes,
      now,
      ...floorTimestamp === void 0 ? {} : { floorTimestamp }
    });
    record.tier = thermalTier(
      ageDays,
      incoming.has(record.path),
      record.lifecycle,
      isActive(relativeFilePath, active.files, active.directories),
      config
    );
    record.age_days = Math.round(ageDays * 10) / 10;
  }
  const delta = computeDelta(options.previousRecords ?? [], records);
  const sourceCount = records.length;
  const catalog = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root_label: config.root_label,
    records
  };
  const freshness = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root: config.root_label + "/",
    source_count: sourceCount,
    palier: palier(sourceCount, config),
    sharded: shardsEnabled(sourceCount, config),
    total_token_estimate: records.reduce((total, record) => total + record.token_estimate, 0),
    catalog_sha256: sha256(canonicalJson(records)),
    delta: {
      added_count: delta.added_count,
      modified_count: delta.modified_count,
      removed_count: delta.removed_count
    },
    scan_stats: {
      accepted: sourceCount,
      skipped
    },
    lifecycle_counts: countBy(records, "lifecycle"),
    tier_counts: countBy(records, "tier")
  };
  return { catalog, graph, freshness, delta };
}
var execFileAsync2 = promisify(execFile);
var DIRECTORY_KEYS = [
  "index",
  "inbox",
  "memory",
  "contexts",
  "skills",
  "sources",
  "outputs",
  "engine",
  "archive"
];
var PATH_KEYS_BY_DIRECTORY = {
  index: [
    "index",
    "deltas",
    "catalog",
    "catalog_shards",
    "catalog_index",
    "graph",
    "freshness",
    "routing"
  ],
  inbox: ["inbox"],
  memory: ["memory"],
  contexts: ["contexts"],
  skills: ["skills"],
  sources: ["sources"],
  outputs: ["outputs"],
  engine: ["engine"],
  archive: ["archive"]
};
var SkinError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SkinError";
  }
};
var BUILTIN_PRESETS = {
  universal: {
    name: "universal",
    directories: {
      index: "00_index",
      inbox: "01_inbox",
      memory: "10_memory",
      contexts: "20_contexts",
      skills: "30_skills",
      sources: "40_sources",
      outputs: "50_outputs",
      engine: "70_engine",
      archive: "90_archive"
    }
  },
  brain: {
    name: "brain",
    directories: {
      index: "00_map",
      inbox: "01_signals",
      memory: "10_memory",
      contexts: "20_associations",
      skills: "30_patterns",
      sources: "40_inputs",
      outputs: "50_synthesis",
      engine: "70_engine",
      archive: "90_archive"
    }
  }
};
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toPosix(value) {
  return value.replace(/\\/gu, "/");
}
function firstSegment(value) {
  const segment = toPosix(value).split("/")[0];
  if (!segment || segment === "." || segment === "..") {
    throw new SkinError("Configured vault paths must begin with a directory name.");
  }
  return segment;
}
function validateDirectoryName(value) {
  if (!/^\d{2}_[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new SkinError("Skin directory names must be a single numbered directory name.");
  }
  return value;
}
function currentDirectories(config) {
  return {
    index: firstSegment(config.paths.index),
    inbox: firstSegment(config.paths.inbox),
    memory: firstSegment(config.paths.memory),
    contexts: firstSegment(config.paths.contexts),
    skills: firstSegment(config.paths.skills),
    sources: firstSegment(config.paths.sources),
    outputs: firstSegment(config.paths.outputs),
    engine: firstSegment(config.paths.engine),
    archive: firstSegment(config.paths.archive)
  };
}
function customSkinDirectories(config, skin) {
  const carrier = config;
  const entry = carrier.skins?.[skin];
  if (!isRecord7(entry)) {
    return {};
  }
  const candidate = isRecord7(entry.directories) ? entry.directories : entry;
  const directories = {};
  for (const key of DIRECTORY_KEYS) {
    const value = candidate[key];
    if (typeof value === "string") {
      directories[key] = validateDirectoryName(value);
    }
  }
  return directories;
}
function resolveSkinPreset(config, skin) {
  const builtin = BUILTIN_PRESETS[skin];
  const directories = {
    ...builtin.directories,
    ...customSkinDirectories(config, skin)
  };
  const names = Object.values(directories);
  if (new Set(names).size !== names.length) {
    throw new SkinError("A skin cannot map multiple vault areas to the same directory.");
  }
  return { name: skin, directories };
}
function replacePathPrefix(value, from, to) {
  const normalized = toPosix(value);
  if (normalized === from) {
    return to;
  }
  if (normalized.startsWith(from + "/")) {
    return to + normalized.slice(from.length);
  }
  return normalized;
}
function configForSkin(config, preset) {
  const updated = structuredClone(config);
  const current = currentDirectories(config);
  for (const key of DIRECTORY_KEYS) {
    const from = current[key];
    const to = preset.directories[key];
    for (const pathKey of PATH_KEYS_BY_DIRECTORY[key]) {
      updated.paths[pathKey] = replacePathPrefix(updated.paths[pathKey], from, to);
    }
    updated.canonical_dirs = updated.canonical_dirs.map(
      (value) => replacePathPrefix(value, from, to)
    );
    updated.activity.active_paths = updated.activity.active_paths.map(
      (value) => replacePathPrefix(value, from, to)
    );
    updated.activity.active_dir_prefixes = updated.activity.active_dir_prefixes.map(
      (value) => replacePathPrefix(value, from, to)
    );
  }
  return updated;
}
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function planSkin(root, config, skin) {
  const vaultRoot = resolve(root);
  const preset = resolveSkinPreset(config, skin);
  const current = currentDirectories(config);
  const moves = DIRECTORY_KEYS.filter((key) => current[key] !== preset.directories[key]).map((key) => ({
    key,
    from: current[key],
    to: preset.directories[key]
  }));
  const configPathBefore = join(vaultRoot, config.paths.index, "vault.config.yml");
  const updatedConfig = configForSkin(config, preset);
  const configPathAfter = join(vaultRoot, updatedConfig.paths.index, "vault.config.yml");
  if (!await pathExists(configPathBefore)) {
    throw new SkinError("The vault configuration file is required before applying a skin.");
  }
  for (const move of moves) {
    const source = join(vaultRoot, move.from);
    const destination = join(vaultRoot, move.to);
    if (!await isDirectory(source)) {
      throw new SkinError("Configured source directory is missing: " + move.from);
    }
    if (await pathExists(destination)) {
      throw new SkinError("Skin destination already exists: " + move.to);
    }
  }
  return {
    skin,
    preset,
    moves,
    updated_config: updatedConfig,
    config_path_before: configPathBefore,
    config_path_after: configPathAfter
  };
}
async function defaultGitRunner(root, args) {
  try {
    const result = await execFileAsync2("git", ["-C", root, ...args]);
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      unavailable: false
    };
  } catch (error) {
    const failure = error;
    return {
      ok: false,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      unavailable: failure.code === "ENOENT"
    };
  }
}
async function ensureCleanWorktree(root, runGit = defaultGitRunner) {
  const probe = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ok) {
    if (probe.unavailable || /not a git repository/iu.test(probe.stderr)) {
      return "filesystem";
    }
    throw new SkinError("Git could not determine whether the vault is a worktree.");
  }
  if (probe.stdout.trim() !== "true") {
    return "filesystem";
  }
  const status = await runGit(root, ["status", "--porcelain"]);
  if (!status.ok) {
    throw new SkinError("Git could not verify the worktree state.");
  }
  if (status.stdout.trim()) {
    throw new SkinError("Skin changes require a clean Git worktree.");
  }
  return "git";
}
async function moveDirectory(root, move, mode, runGit) {
  if (mode === "git") {
    const result = await runGit(root, ["mv", move.from, move.to]);
    if (!result.ok) {
      throw new SkinError("Git could not move " + move.from + " to " + move.to + ".");
    }
    return;
  }
  await rename(join(root, move.from), join(root, move.to));
}
var ESCAPEABLE_PATTERN_CHARACTERS = /* @__PURE__ */ new Set([
  "\\",
  "^",
  "$",
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|"
]);
function escapePattern(value) {
  return Array.from(value, (character) => ESCAPEABLE_PATTERN_CHARACTERS.has(character) ? "\\" + character : character).join("");
}
function replaceManagedPathTokens(text, moves) {
  let updated = text;
  for (const move of moves) {
    const pattern = new RegExp(
      `(^|[\\s"'(/])` + escapePattern(move.from) + `(?=$|[\\s/"')])`,
      "gmu"
    );
    updated = updated.replace(pattern, (_match, prefix) => prefix + move.to);
  }
  return updated;
}
function rewriteScalarLine(line, moves) {
  const match = /^(\s*(?:-\s+|[A-Za-z_][A-Za-z0-9_-]*:\s+))(["']?)([^#\s"']+)(.*)$/u.exec(line);
  if (!match) {
    return line;
  }
  const prefix = match[1] ?? "";
  const quote = match[2] ?? "";
  const value = match[3] ?? "";
  const suffix = match[4] ?? "";
  const updated = moves.reduce(
    (current, move) => replacePathPrefix(current, move.from, move.to),
    value
  );
  return prefix + quote + updated + suffix;
}
function rewriteManagedConfigReferences(text, moves) {
  let section = "";
  let activityList = "";
  return text.split(/\r?\n/u).map((line) => {
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(?:#.*)?)?$/u.exec(line);
    if (top) {
      section = top[1] ?? "";
      activityList = "";
      return line;
    }
    if (section === "activity") {
      const nested = /^\s+([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(?:#.*)?)?$/u.exec(line);
      if (nested) {
        activityList = nested[1] ?? "";
        return line;
      }
    }
    const isManaged = section === "paths" || section === "canonical_dirs" || section === "activity" && (activityList === "active_paths" || activityList === "active_dir_prefixes");
    return isManaged ? rewriteScalarLine(line, moves) : line;
  }).join("\n");
}
function rewriteManagedLoaderBlock(text, moves) {
  const begin = "<!-- openbrain:begin -->";
  const end = "<!-- openbrain:end -->";
  const start = text.indexOf(begin);
  if (start === -1) {
    return text;
  }
  const finish = text.indexOf(end, start + begin.length);
  if (finish === -1) {
    return text;
  }
  const blockEnd = finish + end.length;
  return text.slice(0, start) + replaceManagedPathTokens(text.slice(start, blockEnd), moves) + text.slice(blockEnd);
}
async function writeAtomically3(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}
async function updateManagedReferences(root, plan) {
  const changed = [];
  const configText = await readFile(plan.config_path_after, "utf8");
  const updatedConfigText = rewriteManagedConfigReferences(configText, plan.moves);
  if (updatedConfigText !== configText) {
    await writeAtomically3(plan.config_path_after, updatedConfigText);
    changed.push(plan.config_path_after);
  }
  for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const path = join(root, filename);
    if (!await pathExists(path)) {
      continue;
    }
    const text = await readFile(path, "utf8");
    const updated = rewriteManagedLoaderBlock(text, plan.moves);
    if (updated !== text) {
      await writeAtomically3(path, updated);
      changed.push(path);
    }
  }
  return changed;
}
async function applySkin(root, config, skin, options = {}) {
  const vaultRoot = resolve(root);
  const plan = await planSkin(vaultRoot, config, skin);
  const runGit = options.runGit ?? defaultGitRunner;
  const mode = await ensureCleanWorktree(vaultRoot, runGit);
  if (options.dryRun) {
    return {
      plan,
      mode,
      changed_files: [],
      rescan_required: plan.moves.length > 0
    };
  }
  for (const move of plan.moves) {
    await moveDirectory(vaultRoot, move, mode, runGit);
  }
  const changedFiles = await updateManagedReferences(vaultRoot, plan);
  return {
    plan,
    mode,
    changed_files: changedFiles,
    rescan_required: plan.moves.length > 0
  };
}

// src/core/status.ts
async function getVaultStatus(root, config, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  let health = await checkVaultHealth(root, config, { ...options, now });
  const shouldRescan = options.rescan === true || options.auto === true && (health.stale || !health.index_available || !health.healthy);
  let freshness;
  let rescanned = false;
  if (shouldRescan) {
    const previousRecords = await loadCatalog(root, config);
    const scan = await scanVault(root, config, { now, previousRecords });
    const write = await writeIndexArtifacts(root, config, scan, { now });
    freshness = write.freshness;
    rescanned = true;
    health = await checkVaultHealth(root, config, { ...options, now });
  }
  return {
    checked_at: now.toISOString(),
    rescanned,
    ...freshness ? { freshness } : {},
    health
  };
}

// src/prefs/types.ts
var PREFERENCE_LEDGER_SCHEMA_VERSION = 3;
var PREFERENCE_WEIGHTS = [1, 2, 3, 4, 5];
var PREFERENCE_STATUSES = [
  "law",
  "active",
  "proposed",
  "probation",
  "retired"
];

// src/prefs/validation.ts
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var PREFERENCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isRecord8(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isPreferenceWeight(value) {
  return typeof value === "number" && PREFERENCE_WEIGHTS.includes(value);
}
function isPreferenceStatus(value) {
  return typeof value === "string" && PREFERENCE_STATUSES.includes(value);
}
function isLedgerDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
function validateStringArray(value, label, errors, options = {}) {
  if (!Array.isArray(value) || !options.allowEmpty && value.length === 0) {
    errors.push(`${label} must be a non-empty array.`);
    return false;
  }
  if (value.some((item) => !isNonEmptyString(item))) {
    errors.push(`${label} must contain non-empty strings.`);
    return false;
  }
  return true;
}
function validatePreference(value, index, errors, warnings, ids) {
  const label = `preferences[${index}]`;
  if (!isRecord8(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  if (!isNonEmptyString(value.id) || !PREFERENCE_ID_PATTERN.test(value.id)) {
    errors.push(`${label}.id must be a kebab-case identifier.`);
  } else if (ids.has(value.id)) {
    errors.push(`${label}.id duplicates ${value.id}.`);
  } else {
    ids.add(value.id);
  }
  if (!isPreferenceWeight(value.weight)) {
    errors.push(`${label}.weight must be an integer from 1 through 5.`);
  }
  if (!isPreferenceStatus(value.status)) {
    errors.push(`${label}.status is invalid.`);
  }
  validateStringArray(value.domains, `${label}.domains`, errors);
  for (const field of ["statement", "why", "apply"]) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${label}.${field} must be a non-empty string.`);
    }
  }
  for (const field of ["origin", "last_seen"]) {
    if (!isLedgerDate(value[field])) {
      errors.push(`${label}.${field} must be an ISO date (YYYY-MM-DD).`);
    }
  }
  if (typeof value.core !== "boolean") {
    errors.push(`${label}.core must be boolean.`);
  }
  if (value.scoped !== void 0 && typeof value.scoped !== "boolean") {
    errors.push(`${label}.scoped must be boolean when present.`);
  }
  if (value.source !== void 0 && !isNonEmptyString(value.source)) {
    errors.push(`${label}.source must be a non-empty string when present.`);
  }
  if (value.links !== void 0) {
    validateStringArray(value.links, `${label}.links`, errors, {
      allowEmpty: true
    });
  }
  if (!Array.isArray(value.evidence)) {
    errors.push(`${label}.evidence must be an array.`);
  } else {
    value.evidence.forEach((event, eventIndex) => {
      const eventLabel = `${label}.evidence[${eventIndex}]`;
      if (!isRecord8(event)) {
        errors.push(`${eventLabel} must be an object.`);
        return;
      }
      if (!isLedgerDate(event.date)) {
        errors.push(`${eventLabel}.date must be an ISO date (YYYY-MM-DD).`);
      }
      if (!isPreferenceWeight(event.weight_set)) {
        errors.push(`${eventLabel}.weight_set must be an integer from 1 through 5.`);
      }
      if (!isNonEmptyString(event.signal)) {
        errors.push(`${eventLabel}.signal must be a non-empty string.`);
      }
      if (event.quote !== void 0 && typeof event.quote !== "string") {
        errors.push(`${eventLabel}.quote must be a string when present.`);
      }
    });
  }
  if (isPreferenceWeight(value.weight) && isPreferenceStatus(value.status)) {
    if (value.status === "law" && value.weight !== 5) {
      warnings.push(`${label} is law but has weight ${value.weight}.`);
    }
    if (value.weight === 5 && !["law", "retired"].includes(value.status)) {
      warnings.push(`${label} has weight 5 but is ${value.status}.`);
    }
    if (value.status === "proposed" && value.weight > 2) {
      warnings.push(`${label} is proposed but has weight ${value.weight}.`);
    }
    if (value.core === true && value.weight < 3) {
      warnings.push(`${label} is core but has low weight ${value.weight}.`);
    }
  }
}
function validatePreferenceLedger(value) {
  const errors = [];
  const warnings = [];
  if (!isRecord8(value)) {
    return {
      valid: false,
      errors: ["Preference ledger must be a JSON object."],
      warnings
    };
  }
  if (value.schema_version !== PREFERENCE_LEDGER_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be ${PREFERENCE_LEDGER_SCHEMA_VERSION} for the Hermes v3 ledger.`
    );
  }
  if (!Array.isArray(value.preferences)) {
    errors.push("preferences must be an array.");
    return { valid: false, errors, warnings };
  }
  const ids = /* @__PURE__ */ new Set();
  value.preferences.forEach(
    (preference, index) => validatePreference(preference, index, errors, warnings, ids)
  );
  const knownIds = new Set(
    value.preferences.filter(isRecord8).map((preference) => preference.id).filter(isNonEmptyString)
  );
  value.preferences.forEach((preference, index) => {
    if (!isRecord8(preference) || !Array.isArray(preference.links)) {
      return;
    }
    preference.links.forEach((link) => {
      if (typeof link === "string" && !knownIds.has(link)) {
        warnings.push(`preferences[${index}] links to unknown id ${link}.`);
      }
    });
  });
  return { valid: errors.length === 0, errors, warnings };
}
function assertValidPreferenceLedger(value) {
  const result = validatePreferenceLedger(value);
  if (!result.valid) {
    throw new TypeError(`Invalid preference ledger: ${result.errors.join(" ")}`);
  }
}

// src/prefs/ledger.ts
function clonePreference(preference) {
  const { domains, links, evidence, ...rest } = preference;
  return {
    ...rest,
    domains: [...domains],
    ...links ? { links: [...links] } : {},
    evidence: evidence.map((event) => ({ ...event }))
  };
}
function toLedgerDate(date) {
  return date.toISOString().slice(0, 10);
}
function parseLedgerDate(value) {
  return /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
}
function derivePreferenceStatus(weight, previousStatus) {
  if (previousStatus === "probation" || previousStatus === "retired") {
    return previousStatus;
  }
  if (weight === 5) {
    return "law";
  }
  if (weight >= 3) {
    return "active";
  }
  return "proposed";
}
function logPreference(ledger, id, input, now = /* @__PURE__ */ new Date()) {
  assertValidPreferenceLedger(ledger);
  if (typeof input.signal !== "string" || input.signal.trim().length === 0) {
    throw new TypeError("Preference evidence requires a non-empty signal.");
  }
  if (input.date !== void 0 && !isLedgerDate(input.date)) {
    throw new TypeError("Preference evidence date must be YYYY-MM-DD.");
  }
  if (input.weight !== void 0 && !isPreferenceWeight(input.weight)) {
    throw new TypeError("Preference evidence weight must be from 1 through 5.");
  }
  if (input.status !== void 0 && !isPreferenceStatus(input.status)) {
    throw new TypeError("Preference status is invalid.");
  }
  if (input.quote !== void 0 && typeof input.quote !== "string") {
    throw new TypeError("Preference evidence quote must be a string.");
  }
  const preferenceIndex = ledger.preferences.findIndex(
    (preference) => preference.id === id
  );
  if (preferenceIndex === -1) {
    throw new RangeError(`Unknown preference id: ${id}.`);
  }
  const current = ledger.preferences[preferenceIndex];
  const date = input.date ?? toLedgerDate(now);
  const weight = input.weight ?? current.weight;
  const evidence = {
    date,
    weight_set: weight,
    signal: input.signal,
    ...input.quote === void 0 ? {} : { quote: input.quote }
  };
  const nextPreference = {
    ...clonePreference(current),
    weight,
    status: input.status ?? derivePreferenceStatus(weight, current.status),
    last_seen: date,
    evidence: [...current.evidence.map((event) => ({ ...event })), evidence]
  };
  const preferences = ledger.preferences.map(
    (preference, index) => index === preferenceIndex ? nextPreference : clonePreference(preference)
  );
  const next = { ...ledger, preferences };
  assertValidPreferenceLedger(next);
  return next;
}
function listPreferences(ledger, options = {}) {
  assertValidPreferenceLedger(ledger);
  const today = options.today ?? /* @__PURE__ */ new Date();
  return ledger.preferences.filter((preference) => {
    if (options.status && preference.status !== options.status) {
      return false;
    }
    if (options.domain && !preference.domains.includes(options.domain)) {
      return false;
    }
    if (options.minWeight && preference.weight < options.minWeight) {
      return false;
    }
    if (options.staleDays !== void 0) {
      const ageInMilliseconds = today.getTime() - parseLedgerDate(preference.last_seen).getTime();
      const ageInDays = ageInMilliseconds / (24 * 60 * 60 * 1e3);
      if (ageInDays <= options.staleDays) {
        return false;
      }
    }
    return true;
  }).sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id)).map(clonePreference);
}
function getCorePreferences(ledger) {
  return listPreferences(ledger).filter(
    (preference) => preference.core && preference.status !== "retired"
  );
}

// src/prefs/render.ts
function renderPreference(preference) {
  const domains = preference.domains.join(", ");
  return [
    `## [w${preference.weight}] ${preference.id} (${domains})`,
    preference.statement,
    `_Apply:_ ${preference.apply}`,
    ""
  ];
}
function renderPreferenceCore(ledger) {
  assertValidPreferenceLedger(ledger);
  const lines = [
    "# OpenBrain Preferences Core (always-on)",
    "",
    "Generated from 10_memory/preferences/_ledger.json. Do not edit this file by hand.",
    "",
    "Apply these active core preferences to every substantive response. Scoped preferences remain available in the ledger for context-specific work.",
    ""
  ];
  for (const preference of getCorePreferences(ledger)) {
    lines.push(...renderPreference(preference));
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderPreferenceMirror(ledger) {
  const core = renderPreferenceCore(ledger).trimEnd();
  return [
    "## OpenBrain preference core",
    "",
    "The generated preferences below are authoritative for this vault.",
    "",
    core
  ].join("\n");
}
var PREFERENCE_LEDGER_RELATIVE_PATH = join(
  "10_memory",
  "preferences",
  "_ledger.json"
);
var PREFERENCE_CORE_RELATIVE_PATH = join(
  "10_memory",
  "preferences",
  "_core.md"
);
function nodeErrorHasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function writeAtomically4(path, content) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.openbrain-prefs-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
async function loadPreferenceLedger(vaultRoot) {
  const path = join(vaultRoot, PREFERENCE_LEDGER_RELATIVE_PATH);
  try {
    const raw = await readFile(path, "utf8");
    const ledger = JSON.parse(raw);
    assertValidPreferenceLedger(ledger);
    return ledger;
  } catch (error) {
    if (nodeErrorHasCode(error, "ENOENT")) {
      throw new Error(`Preference ledger does not exist: ${path}.`);
    }
    throw error;
  }
}
async function savePreferenceLedger(vaultRoot, ledger) {
  assertValidPreferenceLedger(ledger);
  await writeAtomically4(
    join(vaultRoot, PREFERENCE_LEDGER_RELATIVE_PATH),
    `${JSON.stringify(ledger, null, 2)}
`
  );
}
async function writePreferenceCore(vaultRoot, ledger) {
  await writeAtomically4(
    join(vaultRoot, PREFERENCE_CORE_RELATIVE_PATH),
    renderPreferenceCore(ledger)
  );
}

// src/loaders/markers.ts
var OPENBRAIN_LOADER_BEGIN_MARKER = "<!-- openbrain:begin -->";
var OPENBRAIN_LOADER_END_MARKER = "<!-- openbrain:end -->";
var DEFAULT_LOADER_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md"
];

// src/prefs/mirror.ts
var PREFERENCE_MIRROR_BEGIN_MARKER = "<!-- openbrain:prefs:begin -->";
var PREFERENCE_MIRROR_END_MARKER = "<!-- openbrain:prefs:end -->";
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var preferenceMirrorPattern = new RegExp(
  `${escapeRegExp(PREFERENCE_MIRROR_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(PREFERENCE_MIRROR_END_MARKER)}`,
  "g"
);
function countOccurrences(content, marker) {
  return content.split(marker).length - 1;
}
function assertWellFormedMirrorMarkers(content) {
  const beginCount = countOccurrences(content, PREFERENCE_MIRROR_BEGIN_MARKER);
  const endCount = countOccurrences(content, PREFERENCE_MIRROR_END_MARKER);
  if (beginCount !== endCount) {
    throw new Error("OpenBrain preference mirror markers are malformed.");
  }
  const markerPattern = new RegExp(
    `${escapeRegExp(PREFERENCE_MIRROR_BEGIN_MARKER)}|${escapeRegExp(PREFERENCE_MIRROR_END_MARKER)}`,
    "g"
  );
  let insideMirror = false;
  for (const match of content.matchAll(markerPattern)) {
    if (match[0] === PREFERENCE_MIRROR_BEGIN_MARKER) {
      if (insideMirror) {
        throw new Error("OpenBrain preference mirror markers are malformed.");
      }
      insideMirror = true;
    } else {
      if (!insideMirror) {
        throw new Error("OpenBrain preference mirror markers are malformed.");
      }
      insideMirror = false;
    }
  }
}
function renderPreferenceMirrorBlock(ledger) {
  return [
    PREFERENCE_MIRROR_BEGIN_MARKER,
    renderPreferenceMirror(ledger),
    PREFERENCE_MIRROR_END_MARKER
  ].join("\n");
}
function syncPreferenceMirrorContent(content, ledger) {
  assertWellFormedMirrorMarkers(content);
  const block = renderPreferenceMirrorBlock(ledger);
  const markerCount2 = countOccurrences(content, PREFERENCE_MIRROR_BEGIN_MARKER);
  if (markerCount2 === 0) {
    if (content.length === 0) {
      return `${block}
`;
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}${block}
`;
  }
  let replacedFirstBlock = false;
  return content.replace(preferenceMirrorPattern, () => {
    if (!replacedFirstBlock) {
      replacedFirstBlock = true;
      return block;
    }
    return "";
  });
}
function nodeErrorHasCode2(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function writeAtomically5(path, content) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.openbrain-prefs-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
async function syncPreferenceMirrorFile(path, ledger) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!nodeErrorHasCode2(error, "ENOENT")) {
      throw error;
    }
  }
  const next = syncPreferenceMirrorContent(current, ledger);
  if (next !== current) {
    await writeAtomically5(path, next);
  }
  return { path, changed: next !== current };
}
async function syncPreferenceMirrors(vaultRoot, ledger, options = {}) {
  const files = options.files ?? DEFAULT_LOADER_FILENAMES;
  return Promise.all(
    files.map(
      (filename) => syncPreferenceMirrorFile(join(vaultRoot, filename), ledger)
    )
  );
}

// src/free-mode/config.ts
var FREE_MODE_VALUES = ["off", "calibrated"];
function isRecord9(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFreeMode(value) {
  return typeof value === "string" && FREE_MODE_VALUES.includes(value);
}
function parseFreeMode(value, fallback = "off") {
  if (value === void 0 || value === null) {
    return fallback;
  }
  if (isFreeMode(value)) {
    return value;
  }
  throw new TypeError('interaction.free_mode must be "off" or "calibrated".');
}
function readFreeMode(config) {
  if (config === void 0 || config === null) {
    return "off";
  }
  if (!isRecord9(config)) {
    throw new TypeError("Vault configuration must be a mapping.");
  }
  const interaction = config.interaction;
  if (interaction === void 0 || interaction === null) {
    return "off";
  }
  if (!isRecord9(interaction)) {
    throw new TypeError("interaction must be a mapping.");
  }
  return parseFreeMode(interaction.free_mode);
}

// src/free-mode/prompts.ts
var FREE_MODE_CHECK_TEMPLATE = "Free Mode check: A leads to [consequence]. B would [benefit], based on [evidence]. I recommend B. Continue with A / switch to B / use your judgment?";
var OPTIONAL_IDEA_TEMPLATE = "One optional idea: [idea]. It fits because [discovery]. I have not changed it. Want it scoped next?";
var FREE_MODE_ATTENTION_PRIORITY = [
  "safety confirmation",
  "Free Mode checkpoint",
  "Hermes preference nudge",
  "optional idea"
];
var FREE_MODE_STATE_SCHEMA_VERSION = 1;
var FREE_MODE_STATE_RELATIVE_PATH = join(
  ".open-brain",
  "local",
  "free-mode-state.json"
);
var STATE_KEYS = [
  "schemaVersion",
  "createdAt",
  "updatedAt",
  "mode",
  "dismissedIdeaFingerprints"
];
var SHA256_HEX = /^[a-f0-9]{64}$/;
function isRecord10(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}
function nowIso(now) {
  return now.toISOString();
}
function nodeErrorHasCode3(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function requireFreeMode(mode) {
  if (!isFreeMode(mode)) {
    throw new TypeError("Free Mode local state contains an invalid mode.");
  }
  return mode;
}
function validateFreeModeLocalState(value) {
  if (!isRecord10(value)) {
    throw new TypeError("Free Mode local state must be a JSON object.");
  }
  const keys = Object.keys(value);
  if (keys.length !== STATE_KEYS.length || keys.some((key) => !STATE_KEYS.includes(key))) {
    throw new TypeError("Free Mode local state contains unsupported fields.");
  }
  if (value.schemaVersion !== FREE_MODE_STATE_SCHEMA_VERSION) {
    throw new TypeError("Unsupported Free Mode local-state schema version.");
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new TypeError("Free Mode local state timestamps must be ISO dates.");
  }
  if (!isFreeMode(value.mode)) {
    throw new TypeError("Free Mode local state contains an invalid mode.");
  }
  if (!Array.isArray(value.dismissedIdeaFingerprints) || value.dismissedIdeaFingerprints.some(
    (fingerprint) => typeof fingerprint !== "string" || !SHA256_HEX.test(fingerprint)
  )) {
    throw new TypeError("Dismissed ideas must be SHA-256 fingerprints.");
  }
  if (new Set(value.dismissedIdeaFingerprints).size !== value.dismissedIdeaFingerprints.length) {
    throw new TypeError("Dismissed idea fingerprints must be unique.");
  }
  return {
    schemaVersion: FREE_MODE_STATE_SCHEMA_VERSION,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    mode: value.mode,
    dismissedIdeaFingerprints: [...value.dismissedIdeaFingerprints]
  };
}
function createFreeModeLocalState(mode = "off", now = /* @__PURE__ */ new Date()) {
  const timestamp = nowIso(now);
  return {
    schemaVersion: FREE_MODE_STATE_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    mode: requireFreeMode(mode),
    dismissedIdeaFingerprints: []
  };
}
function getFreeModeStatePath(vaultRoot) {
  return join(vaultRoot, FREE_MODE_STATE_RELATIVE_PATH);
}
async function loadFreeModeLocalState(vaultRoot, fallbackMode = "off", now = /* @__PURE__ */ new Date()) {
  const statePath = getFreeModeStatePath(vaultRoot);
  try {
    const raw = await readFile(statePath, "utf8");
    return validateFreeModeLocalState(JSON.parse(raw));
  } catch (error) {
    if (nodeErrorHasCode3(error, "ENOENT")) {
      return createFreeModeLocalState(fallbackMode, now);
    }
    throw error;
  }
}
async function saveFreeModeLocalState(vaultRoot, state) {
  const safeState = validateFreeModeLocalState(state);
  const statePath = getFreeModeStatePath(vaultRoot);
  const stateDirectory = dirname(statePath);
  const temporaryPath = join(
    stateDirectory,
    `.free-mode-${randomUUID()}.tmp`
  );
  await mkdir(stateDirectory, { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(safeState, null, 2)}
`,
      "utf8"
    );
    await rename(temporaryPath, statePath);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
function setFreeModeLocalStateMode(state, mode, now = /* @__PURE__ */ new Date()) {
  const current = validateFreeModeLocalState(state);
  return {
    ...current,
    mode: requireFreeMode(mode),
    updatedAt: nowIso(now)
  };
}

// src/loaders/free-mode-block.ts
function renderFreeModeLoaderBlock(mode) {
  const enabled = mode === "calibrated";
  const lines = [
    OPENBRAIN_LOADER_BEGIN_MARKER,
    "## OpenBrain Free Mode",
    "",
    `Configuration: \`interaction.free_mode: ${mode}\`.`,
    ""
  ];
  if (!enabled) {
    lines.push(
      "Free Mode is off. Do not show proactive Free Mode checkpoints or optional ideas.",
      "",
      "Enable it only when the user selects Calibrated Free Mode.",
      OPENBRAIN_LOADER_END_MARKER
    );
    return lines.join("\n");
  }
  lines.push(
    "Calibrated Free Mode is proactive assistant behaviour, not a bundled free model or provider tier.",
    "Ask before acting only when a concrete, evidence-backed alternative materially changes outcome, scope, reversibility, external impact, cost, security, or maintenance.",
    "Ask at most once per request and only at a safe boundary. Do not interrupt for routine or cosmetic choices.",
    "With explicit carte blanche, choose the better safe route and disclose it at handoff. Safety, destructive, privacy, legal, and publication confirmations still require a checkpoint.",
    "",
    `Checkpoint template: ${FREE_MODE_CHECK_TEMPLATE}`,
    "",
    "After completing work, offer at most one optional idea per session. It must be novel, directly supported by discoveries, material, and safely deferrable. Do not repeat a dismissed idea without materially new evidence.",
    `Optional idea template: ${OPTIONAL_IDEA_TEMPLATE}`,
    "",
    `Shared attention priority: ${FREE_MODE_ATTENTION_PRIORITY.join(" > ")}. If a higher-priority item is present, suppress lower-priority prompts.`,
    "",
    "Local state may retain only mode, timestamps, and opaque dismissed-idea fingerprints. Never retain prompts, chain-of-thought, secrets, or telemetry.",
    OPENBRAIN_LOADER_END_MARKER
  );
  return lines.join("\n");
}
var loaderBlockPattern = new RegExp(
  `${escapeRegExp2(OPENBRAIN_LOADER_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp2(OPENBRAIN_LOADER_END_MARKER)}`,
  "g"
);
function escapeRegExp2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function countOccurrences2(content, marker) {
  return content.split(marker).length - 1;
}
function assertWellFormedMarkers(content) {
  const beginCount = countOccurrences2(content, OPENBRAIN_LOADER_BEGIN_MARKER);
  const endCount = countOccurrences2(content, OPENBRAIN_LOADER_END_MARKER);
  if (beginCount !== endCount) {
    throw new Error(
      "OpenBrain loader markers are malformed. Repair the marker pair before syncing."
    );
  }
  const markerPattern = new RegExp(
    `${escapeRegExp2(OPENBRAIN_LOADER_BEGIN_MARKER)}|${escapeRegExp2(OPENBRAIN_LOADER_END_MARKER)}`,
    "g"
  );
  let insideGeneratedBlock = false;
  for (const match of content.matchAll(markerPattern)) {
    if (match[0] === OPENBRAIN_LOADER_BEGIN_MARKER) {
      if (insideGeneratedBlock) {
        throw new Error(
          "OpenBrain loader markers are malformed. Repair the marker pair before syncing."
        );
      }
      insideGeneratedBlock = true;
    } else {
      if (!insideGeneratedBlock) {
        throw new Error(
          "OpenBrain loader markers are malformed. Repair the marker pair before syncing."
        );
      }
      insideGeneratedBlock = false;
    }
  }
}
function syncLoaderContent(content, mode) {
  assertWellFormedMarkers(content);
  const block = renderFreeModeLoaderBlock(mode);
  const markerCount2 = countOccurrences2(content, OPENBRAIN_LOADER_BEGIN_MARKER);
  if (markerCount2 === 0) {
    if (content.length === 0) {
      return `${block}
`;
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}${block}
`;
  }
  let replacedFirstBlock = false;
  return content.replace(loaderBlockPattern, () => {
    if (!replacedFirstBlock) {
      replacedFirstBlock = true;
      return block;
    }
    return "";
  });
}
function nodeErrorHasCode4(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function writeAtomically6(path, content) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.openbrain-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
async function syncLoaderFile(path, mode) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!nodeErrorHasCode4(error, "ENOENT")) {
      throw error;
    }
  }
  const next = syncLoaderContent(current, mode);
  if (next !== current) {
    await writeAtomically6(path, next);
  }
  return { path, changed: next !== current };
}
async function syncLoaders(vaultRoot, mode, options = {}) {
  const files = options.files ?? DEFAULT_LOADER_FILENAMES;
  return Promise.all(
    files.map((filename) => syncLoaderFile(join(vaultRoot, filename), mode))
  );
}
async function syncLoadersFromConfig(vaultRoot, config, options = {}) {
  return syncLoaders(vaultRoot, readFreeMode(config), options);
}

// src/cli/vault.ts
var ENGINE_VERSION = "0.1.0-alpha.1";
var OPENBRAIN_MANIFEST_FILENAME = ".open-brain.json";
function isRecord11(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function pathExists2(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function readJsonFile(path) {
  const resolvedPath = resolve(path);
  let content;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch {
    throw new Error(`Unable to read JSON file: ${resolvedPath}.`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`JSON file is invalid: ${resolvedPath}.`);
  }
}
async function writeAtomically7(path, contents) {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
async function writeJsonFile(path, value) {
  const resolvedPath = resolve(path);
  await writeAtomically7(resolvedPath, `${JSON.stringify(value, null, 2)}
`);
}
async function copyAtomically(source, target) {
  const directory = dirname(target);
  const temporaryPath = join(
    directory,
    `.${basename(target)}.${randomUUID()}.tmp`
  );
  await mkdir(directory, { recursive: true });
  try {
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, target);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}
async function getPackageRoot() {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (await pathExists2(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate the OpenBrain package root.");
    }
    current = parent;
  }
}
async function copyMissingTree(source, target, isTemplateRoot = true) {
  const entries = await readdir(source, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetName = isTemplateRoot && entry.name === "gitignore.template" ? ".gitignore" : entry.name;
    const targetPath = join(target, targetName);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      copied += await copyMissingTree(sourcePath, targetPath, false);
    } else if (entry.isFile() && !await pathExists2(targetPath)) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      copied += 1;
    }
  }
  return copied;
}
async function ensureFreeModeState(root, mode) {
  const statePath = getFreeModeStatePath(root);
  const existed = await pathExists2(statePath);
  const current = await loadFreeModeLocalState(root, mode);
  if (!existed || current.mode !== mode) {
    await saveFreeModeLocalState(
      root,
      setFreeModeLocalStateMode(current, mode)
    );
  }
}
async function readManifest(root) {
  const path = join(root, OPENBRAIN_MANIFEST_FILENAME);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRecord11(parsed) ? parsed : {};
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {};
    }
    throw new Error("OpenBrain manifest is not valid JSON.");
  }
}
async function writeManifest(root) {
  const previous = await readManifest(root);
  const installedAt = typeof previous.installedAt === "string" ? previous.installedAt : (/* @__PURE__ */ new Date()).toISOString();
  const integrations = Array.isArray(previous.integrations) && previous.integrations.every((item) => typeof item === "string") ? [...previous.integrations] : ["loaders"];
  const next = {
    ...previous,
    engineVersion: ENGINE_VERSION,
    installedAt,
    integrations
  };
  await writeAtomically7(
    join(root, OPENBRAIN_MANIFEST_FILENAME),
    `${JSON.stringify(next, null, 2)}
`
  );
}
async function ensureInitialState(root) {
  const statePath = join(root, "10_memory", "_state.md");
  if (await pathExists2(statePath)) {
    return;
  }
  await writeAtomically7(
    statePath,
    [
      "---",
      "lifecycle: master",
      "---",
      "# Living state",
      "",
      "## Last update",
      "Vault initialized.",
      "",
      "## Health",
      "Run `open-brain status` when that command is available in your installed version.",
      "",
      "## Current work",
      "No work has been recorded yet.",
      "",
      "## Handoff",
      "Read this file first and update it at the end of a substantive session.",
      ""
    ].join("\n")
  );
}
async function initializeGit(root) {
  if (await pathExists2(join(root, ".git"))) {
    return "already-present";
  }
  return new Promise((resolveGit) => {
    const child = spawn("git", ["init", "-b", "main", root], {
      stdio: "ignore"
    });
    child.once("error", () => resolveGit("unavailable"));
    child.once("exit", (code) => {
      resolveGit(code === 0 ? "initialized" : "unavailable");
    });
  });
}
async function readDirectoryEntries(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}
async function packageEnginePath() {
  const path = join(await getPackageRoot(), "bin", "cli.js");
  if (!await pathExists2(path)) {
    throw new Error("The packaged CLI bundle is missing. Run `npm run build` before init or update.");
  }
  return path;
}
async function copyEngineToVault(root, engineDirectory) {
  await copyAtomically(
    await packageEnginePath(),
    join(root, engineDirectory, "cli.js")
  );
}
async function migrationNotes(root) {
  const packageRoot = await getPackageRoot();
  const migrationRoot = join(packageRoot, "MIGRATIONS");
  let entries;
  try {
    entries = await readdir(migrationRoot, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
  const migrationFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  if (migrationFiles.length === 0) {
    return 0;
  }
  const destination = join(root, "MIGRATION_TODO.md");
  let existing = "";
  try {
    existing = await readFile(destination, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  const additions = [];
  for (const filename of migrationFiles) {
    const marker = `<!-- openbrain:migration:${filename} -->`;
    if (existing.includes(marker)) {
      continue;
    }
    const contents = await readFile(join(migrationRoot, filename), "utf8");
    additions.push(marker, `## ${filename}`, "", contents.trim(), "");
  }
  if (additions.length > 0) {
    const prefix = existing ? existing.endsWith("\n") ? "\n" : "\n\n" : "# OpenBrain migration tasks\n\n";
    await writeAtomically7(destination, `${existing}${prefix}${additions.join("\n")}
`);
  }
  return additions.filter((line) => line.startsWith("<!-- openbrain:migration:")).length;
}
async function resolveVaultRoot(start) {
  const requested = resolve(start ?? process.cwd());
  const root = await findVaultRoot(requested);
  const configPath = await findVaultConfigPath(root);
  if (!configPath || dirname(dirname(configPath)) !== root) {
    throw new Error(
      `No OpenBrain vault was found from ${requested}. Run \`open-brain init\` first.`
    );
  }
  return root;
}
async function initVault(target, options = {}) {
  const root = resolve(target);
  if (await findVaultConfigPath(root)) {
    throw new Error(
      `An OpenBrain vault already exists at ${root}. Init never overwrites a vault; use update instead.`
    );
  }
  const existingEntries = await readDirectoryEntries(root);
  if (existingEntries.length > 0) {
    throw new Error(
      `Refusing to initialize non-empty directory ${root}. Choose an empty directory to avoid overwriting files.`
    );
  }
  const packageRoot = await getPackageRoot();
  const templateRoot = join(packageRoot, "templates", "vault");
  if (!await pathExists2(templateRoot)) {
    throw new Error("OpenBrain vault templates are missing from this package.");
  }
  await packageEnginePath();
  await mkdir(root, { recursive: true });
  const copiedTemplateFiles = await copyMissingTree(templateRoot, root);
  const config = await loadConfig(root);
  for (const directory of config.canonical_dirs) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await ensureInitialState(root);
  await copyEngineToVault(root, config.paths.engine);
  await writeManifest(root);
  await ensureFreeModeState(root, readFreeMode(config));
  await syncLoadersFromConfig(root, config);
  const git = options.noGit ? "skipped" : await initializeGit(root);
  return { root, copiedTemplateFiles, git };
}
async function updateVault(start) {
  const root = await resolveVaultRoot(start);
  const config = await loadConfig(root);
  await copyEngineToVault(root, config.paths.engine);
  await writeManifest(root);
  await ensureFreeModeState(root, readFreeMode(config));
  const loaders = await syncLoadersFromConfig(root, config);
  const migrationNotesAdded = await migrationNotes(root);
  return {
    root,
    loadersChanged: loaders.filter((loader) => loader.changed).length,
    migrationNotesAdded
  };
}
function markerCount(contents, marker) {
  return contents.split(marker).length - 1;
}
async function doctorVault(start, repair = false) {
  const root = await resolveVaultRoot(start);
  const config = await loadConfig(root);
  const missingDirectories = [];
  for (const directory of config.canonical_dirs) {
    if (!await pathExists2(join(root, directory))) {
      missingDirectories.push(directory);
    }
  }
  const malformedLoaders = [];
  const missingLoaders = [];
  for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const path = join(root, filename);
    try {
      const contents = await readFile(path, "utf8");
      if (markerCount(contents, OPENBRAIN_LOADER_BEGIN_MARKER) !== 1 || markerCount(contents, OPENBRAIN_LOADER_END_MARKER) !== 1) {
        malformedLoaders.push(filename);
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        missingLoaders.push(filename);
      } else {
        throw error;
      }
    }
  }
  if (repair) {
    for (const directory of missingDirectories) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await syncLoadersFromConfig(root, config);
    await ensureFreeModeState(root, readFreeMode(config));
  }
  return {
    root,
    configFound: true,
    missingDirectories,
    malformedLoaders,
    missingLoaders,
    localFreeModeStateFound: await pathExists2(getFreeModeStatePath(root)),
    repaired: repair
  };
}
async function getVaultConfigPath(root) {
  const configPath = await findVaultConfigPath(root);
  if (!configPath || dirname(dirname(configPath)) !== resolve(root)) {
    throw new Error(`OpenBrain vault configuration is missing from ${root}.`);
  }
  return configPath;
}
async function readConfigText(root) {
  const path = await getVaultConfigPath(root);
  return { path, text: await readFile(path, "utf8") };
}
function patchFreeModeConfig(text, mode) {
  const modeLine = /^(\s*)free_mode:\s*(?:off|calibrated)(\s*(?:#.*)?)$/mu;
  if (modeLine.test(text)) {
    return text.replace(modeLine, (_match, indent, suffix) => `${indent}free_mode: ${mode}${suffix}`);
  }
  const inlineEmpty = /^(\s*)interaction:\s*(?:\{\s*\}|null)(\s*(?:#.*)?)$/mu;
  if (inlineEmpty.test(text)) {
    return text.replace(inlineEmpty, (_match, indent, suffix) => `${indent}interaction:${suffix}
${indent}  free_mode: ${mode}`);
  }
  const interactionHeader = /^(\s*)interaction:\s*(?:#.*)?\r?\n/mu.exec(text);
  if (interactionHeader) {
    const insertion = interactionHeader.index + interactionHeader[0].length;
    const indent = interactionHeader[1] ?? "";
    return `${text.slice(0, insertion)}${indent}  free_mode: ${mode}
${text.slice(insertion)}`;
  }
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}
interaction:
  free_mode: ${mode}
`;
}
async function setVaultFreeMode(start, mode) {
  const root = await resolveVaultRoot(start);
  const config = await readConfigText(root);
  const parsed = parse(config.text);
  if (!isRecord11(parsed)) {
    throw new Error("vault.config.yml must contain a YAML mapping.");
  }
  readFreeMode(parsed);
  const nextText = patchFreeModeConfig(config.text, mode);
  const nextParsed = parse(nextText);
  if (!isRecord11(nextParsed) || readFreeMode(nextParsed) !== mode) {
    throw new Error("Unable to update interaction.free_mode safely.");
  }
  await writeAtomically7(config.path, nextText);
  await syncLoadersFromConfig(root, nextParsed);
  const state = await loadFreeModeLocalState(root, mode);
  const nextState = setFreeModeLocalStateMode(state, mode);
  await saveFreeModeLocalState(root, nextState);
  return {
    mode,
    createdAt: nextState.createdAt,
    updatedAt: nextState.updatedAt,
    dismissedIdeaCount: nextState.dismissedIdeaFingerprints.length
  };
}
async function getVaultFreeModeStatus(start) {
  const root = await resolveVaultRoot(start);
  const config = await readConfigText(root);
  const parsed = parse(config.text);
  const mode = readFreeMode(parsed);
  const state = await loadFreeModeLocalState(root, mode);
  return {
    mode,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    dismissedIdeaCount: state.dismissedIdeaFingerprints.length
  };
}
[...DEFAULT_CONFIG.canonical_dirs];

// src/cli/main.ts
function isRecord12(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function argument(args, name) {
  return isRecord12(args) ? args[name] : void 0;
}
function optionalString(args, name) {
  const value = argument(args, name);
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function booleanArgument(args, name) {
  return argument(args, name) === true;
}
function requiredString(args, name) {
  const value = optionalString(args, name);
  if (!value) {
    throw new Error(`--${name} requires a non-empty value.`);
  }
  return value;
}
function optionalNonNegativeInteger(args, name) {
  const value = optionalString(args, name);
  if (value === void 0) {
    return void 0;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return Number(value);
}
function optionalPreferenceWeight(args, name) {
  const value = optionalString(args, name);
  if (value === void 0) {
    return void 0;
  }
  const weight = Number(value);
  if (!Number.isInteger(weight) || !isPreferenceWeight(weight)) {
    throw new Error(`--${name} must be an integer from 1 through 5.`);
  }
  return weight;
}
function optionalPreferenceStatus(args, name) {
  const value = optionalString(args, name);
  if (value === void 0) {
    return void 0;
  }
  if (!isPreferenceStatus(value)) {
    throw new Error(`--${name} must be a valid preference status.`);
  }
  return value;
}
function requiredSkinName(args) {
  const skin = requiredString(args, "skin");
  if (skin !== "universal" && skin !== "brain") {
    throw new Error("skin must be either universal or brain.");
  }
  return skin;
}
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
function printNotice(message) {
  process.stdout.write(`${import_picocolors.default.cyan(message)}
`);
}
function isGcCandidate(value) {
  if (!isRecord12(value)) {
    return false;
  }
  return typeof value.path === "string" && typeof value.sha256 === "string" && ["master", "working", "ephemeral", "data"].includes(
    value.lifecycle
  ) && ["hot", "warm", "cold"].includes(value.tier) && ["expired_ephemeral", "cold_unreferenced"].includes(
    value.reason
  );
}
function isGcProposal(value) {
  if (!isRecord12(value) || value.schema_version !== GC_PROPOSAL_SCHEMA_VERSION || typeof value.id !== "string" || typeof value.created_at !== "string" || !Array.isArray(value.candidates) || !value.candidates.every(isGcCandidate)) {
    return false;
  }
  if (value.review === void 0) {
    return true;
  }
  return isRecord12(value.review) && (value.review.decision === "approved" || value.review.decision === "rejected") && typeof value.review.reviewer === "string" && typeof value.review.reviewed_at === "string";
}
async function readGcProposal(path) {
  const value = await readJsonFile(path);
  if (!isGcProposal(value)) {
    throw new Error("GC proposal does not match the expected OpenBrain format.");
  }
  return value;
}
var rootArgument = {
  root: {
    type: "string",
    description: "Vault root or a path inside an existing vault."
  }
};
var initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Create a new OpenBrain vault without overwriting existing files."
  },
  args: {
    target: {
      type: "positional",
      description: "Empty destination directory. Defaults to the current directory.",
      required: false
    },
    git: {
      type: "boolean",
      description: "Initialize a local Git repository by default. Use --no-git to skip it.",
      default: true
    }
  },
  async run({ args }) {
    const target = optionalString(args, "target") ?? ".";
    const result = await initVault(target, {
      noGit: !booleanArgument(args, "git")
    });
    printJson({
      ...result,
      message: "Open the vault in your AI CLI and ask it to start onboarding."
    });
  }
});
var updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Replace only the copied engine and managed integration blocks."
  },
  args: rootArgument,
  async run({ args }) {
    printJson(await updateVault(optionalString(args, "root")));
  }
});
var doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Inspect vault wiring and optionally repair only safe generated wiring."
  },
  args: {
    ...rootArgument,
    repair: {
      type: "boolean",
      description: "Create missing canonical directories and resync managed loader blocks.",
      default: false
    }
  },
  async run({ args }) {
    const result = await doctorVault(
      optionalString(args, "root"),
      booleanArgument(args, "repair")
    );
    printJson(result);
    if (!result.repaired && (result.missingDirectories.length > 0 || result.malformedLoaders.length > 0 || result.missingLoaders.length > 0)) {
      printNotice("Run `open-brain doctor --repair` to repair only safe generated wiring.");
      process.exitCode = 2;
    }
  }
});
var scanCommand = defineCommand({
  meta: {
    name: "scan",
    description: "Scan a vault and write deterministic local index artifacts."
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const previousRecords = await loadCatalog(root, config);
    const scan = await scanVault(root, config, { previousRecords });
    await writeIndexArtifacts(root, config, scan);
    printJson(scan);
  }
});
var routeCommand = defineCommand({
  meta: {
    name: "route",
    description: "Return the smallest relevant reading route for a request."
  },
  args: {
    query: {
      type: "positional",
      description: "Natural-language request to route.",
      required: true
    },
    ...rootArgument
  },
  async run({ args }) {
    const query = optionalString(args, "query");
    if (!query) {
      throw new Error("route requires a non-empty query.");
    }
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    printJson(await routeVault(root, config, query));
  }
});
var loaderSyncCommand = defineCommand({
  meta: {
    name: "loader-sync",
    description: "Synchronize the generated Free Mode block in supported loaders."
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    printJson(await syncLoadersFromConfig(root, config));
  }
});
var gcCommand = defineCommand({
  meta: {
    name: "gc",
    description: "Propose safe cleanup candidates without deleting vault content."
  },
  args: {
    ...rootArgument,
    write: {
      type: "string",
      description: "Persist the generated proposal at this JSON path.",
      required: false
    },
    approve: {
      type: "string",
      description: "Record explicit approval in an existing proposal JSON file.",
      required: false
    },
    apply: {
      type: "string",
      description: "Apply an explicitly approved proposal by writing a non-destructive report.",
      required: false
    },
    reviewer: {
      type: "string",
      description: "Name recorded with an explicit GC approval.",
      required: false
    }
  },
  async run({ args }) {
    const writePath = optionalString(args, "write");
    const approvalPath = optionalString(args, "approve");
    const applyPath = optionalString(args, "apply");
    const reviewer = optionalString(args, "reviewer");
    const requestedActions = [writePath, approvalPath, applyPath].filter((value) => value !== void 0);
    if (requestedActions.length > 1) {
      throw new Error("Use only one of --write, --approve, or --apply per gc command.");
    }
    if (reviewer !== void 0 && approvalPath === void 0) {
      throw new Error("--reviewer can only be used with --approve.");
    }
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const records = await loadCatalog(root, config);
    if (approvalPath !== void 0) {
      if (!reviewer) {
        throw new Error("GC approval requires --reviewer with a non-empty value.");
      }
      const path = resolve(approvalPath);
      const proposal2 = await readGcProposal(path);
      const approved = reviewGcProposal(proposal2, "approved", reviewer);
      await writeJsonFile(path, approved);
      printJson(approved);
      return;
    }
    if (applyPath !== void 0) {
      const proposal2 = await readGcProposal(resolve(applyPath));
      printJson(await applyReviewedGcProposal(root, config, proposal2, records));
      return;
    }
    const proposal = proposeGc(records, config, {
      graph: buildGraph(records, config.root_label)
    });
    if (writePath !== void 0) {
      const path = resolve(writePath);
      await writeJsonFile(path, proposal);
      printJson({ proposal, proposal_path: path });
      return;
    }
    printJson(proposal);
  }
});
var healthCommand = defineCommand({
  meta: {
    name: "health",
    description: "Check vault structure, freshness, and index integrity."
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const report = await checkVaultHealth(root, config);
    printJson(report);
    if (!report.healthy) {
      process.exitCode = 2;
    }
  }
});
var statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show vault health and optionally rebuild stale local indexes."
  },
  args: {
    ...rootArgument,
    auto: {
      type: "boolean",
      description: "Rescan when indexes are stale, unavailable, or unhealthy.",
      default: false
    },
    rescan: {
      type: "boolean",
      description: "Rescan local indexes before reporting status.",
      default: false
    }
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const report = await getVaultStatus(root, config, {
      auto: booleanArgument(args, "auto"),
      rescan: booleanArgument(args, "rescan")
    });
    printJson(report);
    if (!report.health.healthy) {
      process.exitCode = 2;
    }
  }
});
var ingestCommand = defineCommand({
  meta: {
    name: "ingest",
    description: "Import supported files from the configured inbox into local archive and briefs."
  },
  args: {
    ...rootArgument,
    "batch-id": {
      type: "string",
      description: "Optional stable identifier for this local import batch.",
      required: false
    }
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const batchId = optionalString(args, "batch-id");
    const report = await ingestInbox(root, config, {
      ...batchId === void 0 ? {} : { batchId }
    });
    printJson(report);
    if (report.failures.length > 0) {
      process.exitCode = 2;
    }
  }
});
var prefsCommand = defineCommand({
  meta: {
    name: "prefs",
    description: "Validate, inspect, regenerate, or log Hermes preferences."
  },
  subCommands: {
    validate: defineCommand({
      meta: {
        name: "validate",
        description: "Validate the preference ledger without changing it."
      },
      args: rootArgument,
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        let result;
        try {
          result = validatePreferenceLedger(
            await readJsonFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH))
          );
        } catch {
          result = {
            valid: false,
            errors: ["Preference ledger is missing or is not valid JSON."],
            warnings: []
          };
        }
        printJson(result);
        if (!result.valid) {
          process.exitCode = 2;
        }
      }
    }),
    list: defineCommand({
      meta: {
        name: "list",
        description: "List preferences with optional deterministic filters."
      },
      args: {
        ...rootArgument,
        status: {
          type: "string",
          description: "Filter by preference status.",
          required: false
        },
        domain: {
          type: "string",
          description: "Filter by preference domain.",
          required: false
        },
        "min-weight": {
          type: "string",
          description: "Filter to weights from 1 through 5.",
          required: false
        },
        "stale-days": {
          type: "string",
          description: "Filter to preferences older than this many days.",
          required: false
        }
      },
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        const status = optionalPreferenceStatus(args, "status");
        const domain = optionalString(args, "domain");
        const minWeight = optionalPreferenceWeight(args, "min-weight");
        const staleDays = optionalNonNegativeInteger(args, "stale-days");
        printJson({
          preferences: listPreferences(ledger, {
            ...status === void 0 ? {} : { status },
            ...domain === void 0 ? {} : { domain },
            ...minWeight === void 0 ? {} : { minWeight },
            ...staleDays === void 0 ? {} : { staleDays }
          })
        });
      }
    }),
    regen: defineCommand({
      meta: {
        name: "regen",
        description: "Regenerate the preference core and portable loader mirrors."
      },
      args: rootArgument,
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        await writePreferenceCore(root, ledger);
        const mirrors = await syncPreferenceMirrors(root, ledger);
        printJson({
          core_path: PREFERENCE_CORE_RELATIVE_PATH,
          loader_mirrors: mirrors
        });
      }
    }),
    log: defineCommand({
      meta: {
        name: "log",
        description: "Append evidence to an existing preference atomically."
      },
      args: {
        ...rootArgument,
        id: {
          type: "string",
          description: "Existing preference identifier.",
          required: true
        },
        signal: {
          type: "string",
          description: "Non-empty evidence signal to record.",
          required: true
        },
        weight: {
          type: "string",
          description: "Optional replacement weight from 1 through 5.",
          required: false
        },
        quote: {
          type: "string",
          description: "Optional supporting quote.",
          required: false
        }
      },
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        const id = requiredString(args, "id");
        const signal = requiredString(args, "signal");
        const weight = optionalPreferenceWeight(args, "weight");
        const quote = optionalString(args, "quote");
        const next = logPreference(ledger, id, {
          signal,
          ...weight === void 0 ? {} : { weight },
          ...quote === void 0 ? {} : { quote }
        });
        await savePreferenceLedger(root, next);
        printJson({
          preference: next.preferences.find((preference) => preference.id === id)
        });
      }
    })
  }
});
var skinCommand = defineCommand({
  meta: {
    name: "skin",
    description: "Apply a portable directory naming preset through the core skin API."
  },
  args: {
    skin: {
      type: "positional",
      description: "Directory naming preset: universal or brain.",
      required: true
    },
    ...rootArgument,
    "dry-run": {
      type: "boolean",
      description: "Show the skin plan without changing the vault.",
      default: false
    }
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const dryRun = booleanArgument(args, "dry-run");
    const result = await applySkin(root, config, requiredSkinName(args), {
      ...dryRun ? { dryRun: true } : {}
    });
    let rescanned = false;
    if (!dryRun && result.rescan_required) {
      const updatedConfig = await loadConfig(root);
      const previousRecords = await loadCatalog(root, updatedConfig);
      const scan = await scanVault(root, updatedConfig, { previousRecords });
      await writeIndexArtifacts(root, updatedConfig, scan);
      rescanned = true;
    }
    printJson({ ...result, rescanned });
  }
});
function freeModeSetCommand(action) {
  const mode = action === "on" ? "calibrated" : "off";
  return defineCommand({
    meta: {
      name: action,
      description: action === "on" ? "Enable Calibrated Free Mode." : "Disable Free Mode prompts."
    },
    args: rootArgument,
    async run({ args }) {
      printJson(await setVaultFreeMode(optionalString(args, "root"), mode));
    }
  });
}
var freeModeCommand = defineCommand({
  meta: {
    name: "free-mode",
    description: "Configure or inspect optional Calibrated Free Mode."
  },
  subCommands: {
    on: freeModeSetCommand("on"),
    off: freeModeSetCommand("off"),
    status: defineCommand({
      meta: {
        name: "status",
        description: "Show safe Free Mode state without exposing fingerprints."
      },
      args: rootArgument,
      async run({ args }) {
        printJson(await getVaultFreeModeStatus(optionalString(args, "root")));
      }
    })
  }
});
var feedbackCommand = defineCommand({
  meta: {
    name: "feedback",
    description: "Print opt-in, safe environment details for a feedback report."
  },
  async run() {
    printNotice("Feedback is opt-in. No data has been sent.");
    printJson({
      version: ENGINE_VERSION,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      next: "Open the project issue tracker and choose the appropriate feedback template. Do not include private vault content, prompts, or secrets."
    });
  }
});
var main = defineCommand({
  meta: {
    name: "open-brain",
    version: ENGINE_VERSION,
    description: "A local, file-based continuity layer for AI CLI assistants."
  },
  subCommands: {
    init: initCommand,
    update: updateCommand,
    doctor: doctorCommand,
    scan: scanCommand,
    route: routeCommand,
    "loader-sync": loaderSyncCommand,
    "free-mode": freeModeCommand,
    feedback: feedbackCommand,
    gc: gcCommand,
    health: healthCommand,
    status: statusCommand,
    ingest: ingestCommand,
    prefs: prefsCommand,
    skin: skinCommand
  }
});
await runMain(main);
