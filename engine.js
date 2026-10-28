/* HWPX 보고서 뷰어 엔진
 *
 * 한컴오피스 한글이 문서를 배치하는 규칙(글꼴 폭, 줄 나눔, 줄 높이, 쪽 나눔)을 따라 .hwpx 문서를
 * 쪽마다 SVG로 그린다. 글꼴 폭 표와 줄 나눔·쪽 나눔 규칙은 python-hwpx 6.10.0(Apache-2.0)의
 * hwpx.form_fit.measure, hwpx.layout.pages 모듈을 자바스크립트로 옮긴 것이다.
 * 단위는 모두 한글 내부 단위(HWPUNIT, 1pt = 100, 1인치 = 7200)다.
 */
(function (global) {
  'use strict';

  const M = global.HWPX_METRICS;
  if (!M) throw new Error('HWPX_METRICS가 없습니다');

  // ------------------------------------------------------------------ 상수
  const LAYOUT_UNIT = 4;
  const DEFAULT_TAB_STOP = 4000;
  const SUPSUB_SIZE = 0.64;
  const UNLISTED_FACE = '한컴바탕';
  const FIXED_SPACE = '　';
  const GLYPH_SPACE = '﷐';
  const OBJ_CHAR = '￼';
  const HANGING = new Set([' ', '　', '﷐']);
  const HALF_EM_SPACES = new Set([' ', ' ']);
  const BOLD_WIDER_FACES = new Set(['한양중고딕', '한양신명조', '한양견고딕']);
  const BOLD_KEPT = new Set(Array.from('ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ·'));
  for (let c = 0x3164; c < 0x318f; c++) BOLD_KEPT.add(String.fromCodePoint(c));
  const LATIN_GRID = { '한양견고딕': 1200 };
  const LATIN_GRID_QUOTES = new Set(Array.from('‘’“”„‟'));
  const EMOJI_UNITS = [1373, 1000];
  const EMOJI_BMP = new Set(Array.from('✅❌❎❗❓❔❕➕➖➗⏰⏳⛔✋✨⭐⬛⬜'));
  const ZERO_WIDTH = new Set(['︎', '️', '‍']);
  const NO_LINE_START = new Set(Array.from('!%),.:;?]}¢°’”‰′″℃〉》」』】〕…·、。'));
  const NO_LINE_END = new Set(Array.from('([{‘“〈《「『【〔'));
  const OPENING_MOVES_DOWN = new Set(['(', '[']);
  const LATIN_QUOTES = new Set(['‘', '’', '“', '”']);
  const ADVANCE_EM = { hangul: 1, wide: 1, upper: 0.7, lower: 0.52, digit: 0.55, space: 0.32, punct: 0.42, other: 0.62 };
  const MIN_LINE_WIDTH = 1440;
  const NO_WRAP = 2 ** 40;
  const SPARE_CUT = 101;
  const SPARE_CUT_FIXED = 2;
  const SPARE_DROPPED = 1282;
  const HWP_PER_MM = 7200 / 25.4;
  const OBJECT_TAGS = new Set(['tbl', 'pic', 'rect', 'ellipse', 'line', 'arc', 'polygon', 'curve', 'connectLine',
    'textart', 'container', 'ole', 'equation', 'video', 'chart', 'checkBtn', 'radioBtn', 'btn', 'button',
    'comboBox', 'edit', 'listBox', 'scrollBar']);
  const FLOATING = new Set(['IN_FRONT_OF_TEXT', 'BEHIND_TEXT']);

  // ------------------------------------------------------------------ 글자 갈래(classify_char)
  const CLS_NAMES = M.classes;
  const CLS_START = new Int32Array(M.classRuns.length >> 1);
  const CLS_VAL = new Uint8Array(M.classRuns.length >> 1);
  for (let i = 0; i < CLS_START.length; i++) {
    CLS_START[i] = M.classRuns[2 * i];
    CLS_VAL[i] = M.classRuns[2 * i + 1];
  }
  const clsCache = new Map();
  function classify(ch) {
    let c = clsCache.get(ch);
    if (c !== undefined) return c;
    const cp = ch.codePointAt(0);
    let lo = 0, hi = CLS_START.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (CLS_START[mid] <= cp) lo = mid; else hi = mid - 1;
    }
    c = CLS_NAMES[CLS_VAL[lo]];
    clsCache.set(ch, c);
    return c;
  }

  function glyphScript(ch) {
    const code = ch.codePointAt(0);
    if (code < 0x250 || LATIN_QUOTES.has(ch)) return 'latin';
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) return 'hanja';
    if ((code >= 0x2000 && code <= 0x2bff) || (code >= 0x3000 && code <= 0x303f) || (code >= 0x3200 && code <= 0x33ff) ||
      (code >= 0xff00 && code <= 0xffef)) return 'symbol';
    return 'hangul';
  }

  // ------------------------------------------------------------------ 글꼴 폭 표
  const GLYPH_INDEX = new Map();
  Array.from(M.glyphs).forEach((g, i) => { if (!GLYPH_INDEX.has(g)) GLYPH_INDEX.set(g, i); });
  function faceTable(table) {
    const cache = new Map();
    return (face) => {
      let m = cache.get(face);
      if (m) return m;
      m = new Map();
      const t = table[face];
      if (t) for (const u of Object.keys(t)) for (const ch of Array.from(t[u])) m.set(ch, +u);
      cache.set(face, m);
      return m;
    };
  }
  const faceGlyphs = faceTable(M.adv);
  const faceHangul = faceTable(M.hangulAdv);
  const italicGlyphs = faceTable(M.italicAdv);
  const boldItalicGlyphs = faceTable(M.boldItalicAdv);
  function slantedGlyphs(face, bold) {
    const base = italicGlyphs(face);
    if (!bold) return base;
    const extra = boldItalicGlyphs(face);
    if (!extra.size) return base;
    const m = new Map(base);
    for (const [k, v] of extra) m.set(k, v);
    return m;
  }
  const KSX = new Set(Array.from(M.ksx));
  function unlistedSyllable(ch) { return ch >= '가' && ch <= '힣' && !KSX.has(ch); }
  function upemOf(face) { return M.upem[face] || (M.design[face] ? M.design[face][0] : 1000); }

  function ownUnits(face, ch) {
    const entry = M.design[face];
    const index = GLYPH_INDEX.has(ch) ? GLYPH_INDEX.get(ch) : -1;
    if (entry && index >= 0) return entry[3][index];
    return faceGlyphs(face).get(ch) || 0;
  }
  const designCache = new Map();
  function designUnits(face, ch) { // ch === null: 한글 음절 하나
    const key = face + '\u0001' + (ch === null ? '\u0002' : ch);
    if (designCache.has(key)) return designCache.get(key);
    let out = null;
    const entry = M.design[face];
    if (!entry) {
      const units = ch !== null && ch !== ' ' ? (faceGlyphs(face).get(ch) || 0) : 0;
      out = units ? [units, M.upem[face]] : null;
    } else {
      const upem = entry[0];
      if (ch === null || ch === ' ') out = [ch === null ? entry[1] : entry[2], upem];
      else {
        let source = face;
        while (source) {
          let units = ownUnits(source, ch);
          if (units) {
            if (source !== face) {
              const us = upemOf(source);
              units = Math.floor((2 * units * upem + us) / (2 * us));
            }
            out = [units, upem];
            break;
          }
          source = M.fallback[source] || '';
        }
      }
    }
    designCache.set(key, out);
    return out;
  }
  function laidOutFace(face) {
    return !face || M.design[face] || M.upem[face] ? face : UNLISTED_FACE;
  }
  function hangulUnits(face, ch) {
    const entry = M.design[face];
    const units = faceHangul(face).get(ch) || 0;
    if (entry && units) return [units, entry[0]];
    return designUnits(face, null);
  }
  function spacingUnits(advance, spacing) {
    const prod = advance * spacing;
    const units = Math.floor((2 * Math.abs(prod) + 100) / 200);
    return prod >= 0 ? units : -units;
  }
  function laidOut(units, upem, height, ratio, spacing, bold, extra) {
    const hq = Math.floor(height / LAYOUT_UNIT);
    let num = units * hq, den = upem;
    if (bold) {
      const k = extra ? 61 : 60; // 1/20 (+ 1/1200)
      num = num * 1200 + hq * k * den;
      den = den * 1200;
    }
    const advance = ratio === 100 ? Math.floor((2 * num + den) / (2 * den)) : Math.floor((num * ratio) / (den * 100));
    return (advance + spacingUnits(advance, spacing)) * LAYOUT_UNIT;
  }
  function laidOutSpace(height, ratio, spacing) {
    const half = Math.floor(Math.floor(height / LAYOUT_UNIT) / 2);
    const advance = Math.floor((2 * half * ratio + 100) / 200);
    return (advance + spacingUnits(advance, spacing)) * LAYOUT_UNIT;
  }
  function laidOutQuarter(height, ratio, spacing) {
    const quarter = Math.floor(Math.floor(height / LAYOUT_UNIT) / 4);
    const advance = Math.floor((2 * quarter * ratio + 100) / 200);
    return (advance + spacingUnits(advance, spacing)) * LAYOUT_UNIT;
  }
  function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  // ------------------------------------------------------------------ 글자 모양(TextStyle)
  const STYLE_DEFAULTS = {
    ratio: 100, spacing: 0, useFontSpace: false, breakLatinWord: 'KEEP_WORD', breakNonLatinWord: 'BREAK_WORD',
    condense: 0, indent: 0, marginLeft: 0, marginRight: 0, spaceBefore: 0, hangulAdvance: 1,
    glyphFace: '', hangulFace: '', latinFace: '', symbolFace: '', scripts: [], head: 0, headHangs: false,
    tabStop: DEFAULT_TAB_STOP, tabStops: [], autoTabLeft: false, autoTabRight: false, bold: false, italic: false,
    autoSpaceLatin: false, autoSpaceDigit: false, scriptSize: 1, lineWrap: 'BREAK',
  };
  function makeStyle(o) { return Object.assign({}, STYLE_DEFAULTS, o); }
  const unspacedCache = new WeakMap();
  function withoutSpacing(style) {
    let s = unspacedCache.get(style);
    if (!s) {
      s = Object.assign({}, style, { spacing: 0, scripts: style.scripts.map(([n, r]) => [n, r, 0]) });
      unspacedCache.set(style, s);
      unspacedCache.set(s, s);
    }
    return s;
  }
  function scaling(ch, style) {
    if (!style.scripts.length) return [style.ratio, style.spacing];
    const script = glyphScript(ch);
    for (const [name, ratio, spacing] of style.scripts) {
      if (name === script) return [HALF_EM_SPACES.has(ch) ? style.ratio : ratio, spacing];
    }
    return [style.ratio, style.spacing];
  }
  function glyphFaceOf(ch, style) {
    const script = glyphScript(ch);
    if (script === 'latin' && style.latinFace) return style.latinFace;
    if (script === 'symbol' && style.symbolFace) return style.symbolFace;
    return style.glyphFace;
  }

  const advCaches = new WeakMap();
  function charAdvance(ch, fontPt, style) {
    let cache = advCaches.get(style);
    if (!cache) { cache = new Map(); advCaches.set(style, cache); }
    const key = fontPt + '\u0001' + ch;
    let v = cache.get(key);
    if (v === undefined) { v = charAdvanceRaw(ch, fontPt, style); cache.set(key, v); }
    return v;
  }
  function charAdvanceRaw(ch, fontPt, style) {
    const typed = ch === GLYPH_SPACE;
    if (typed) ch = '　';
    if (ZERO_WIDTH.has(ch)) return 0;
    const cp = ch.codePointAt(0);
    const emoji = EMOJI_BMP.has(ch) || (cp >= 0x1f000 && cp <= 0x1faff && !(cp >= 0x1f1e6 && cp <= 0x1f1ff));
    fontPt *= style.scriptSize;
    const cls = classify(ch);
    const height = pyRound(fontPt * 100);
    const [ratio, spacing] = scaling(ch, style);
    if (ch === FIXED_SPACE && !typed) return laidOutQuarter(height, ratio, spacing);
    if (HALF_EM_SPACES.has(ch) && !style.useFontSpace) return laidOutSpace(height, ratio, ch === ' ' ? 0 : spacing);
    let face = cls === 'hangul' ? style.hangulFace : glyphFaceOf(ch, style);
    let kept = BOLD_KEPT.has(ch);
    let design, base;
    if (emoji) {
      design = EMOJI_UNITS;
      base = ADVANCE_EM[cls];
    } else if (cls === 'hangul') {
      design = hangulUnits(laidOutFace(style.hangulFace), ch);
      base = style.hangulAdvance;
    } else if (ch === '!') {
      return laidOutSpace(height, ratio, spacing);
    } else {
      design = designUnits(laidOutFace(face), ch);
      base = ADVANCE_EM[cls];
      const slanted = style.italic && design ? slantedGlyphs(face, style.bold).get(ch) : undefined;
      if (slanted !== undefined) design = [slanted, design[1]];
      if (!design && cp >= 0xf020 && cp <= 0xf0ff) design = designUnits('Wingdings', ch); // 기호 글꼴 문자는 Wingdings 폭으로
      if (!design && cp >= 0x3040 && cp <= 0x30ff) {
        design = hangulUnits(laidOutFace(style.hangulFace), '가');
        face = style.hangulFace;
      } else if (design && LATIN_GRID[face]) {
        if (cp < 0x180 || LATIN_GRID_QUOTES.has(ch)) {
          const grid = LATIN_GRID[face];
          design = [Math.floor((2 * design[0] * grid + design[1]) / (2 * design[1])), grid];
        } else kept = true;
      }
    }
    if (design) {
      const bold = style.bold && !emoji && !kept && BOLD_WIDER_FACES.has(face);
      const extra = bold && unlistedSyllable(ch);
      return laidOut(design[0], design[1], height, ratio, spacing, bold, extra);
    }
    if (glyphScript(ch) === 'hanja') return laidOut(1, 1, height, ratio, spacing, false, false);
    return base * fontPt * 100 * ratio / 100 * (1 + spacing / 100);
  }

  // ------------------------------------------------------------------ 한글의 줄 나눔(hancom_line_starts)
  function lineOrigin(style, first) {
    let room;
    if (style.head && style.headHangs) room = first ? style.head : style.head - style.indent;
    else room = first ? Math.max(style.indent, 0) + style.head : Math.max(-style.indent, 0);
    return style.marginLeft + room;
  }
  function tabAdvance(x, stop) { return (Math.floor(x / stop) + 1) * stop - x; }
  function tabReach(x, right, style, after) {
    const stops = style.tabStops.slice();
    if (style.autoTabLeft && style.indent < 0) stops.push([style.marginLeft - style.indent, 'LEFT']);
    if (style.autoTabRight) stops.push([Math.trunc(right), 'RIGHT']);
    stops.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    let passed = false;
    for (const [position, kind] of stops) {
      if (position <= x) continue;
      let start;
      if (kind === 'RIGHT') start = position - after(false);
      else if (kind === 'CENTER') start = position - after(false) / 2;
      else if (kind === 'DECIMAL') start = position - after(true);
      else start = position;
      if (kind !== 'LEFT' || passed) start = Math.min(start, right - after(false));
      if (start >= x) return start - x;
      passed = true;
    }
    if (!style.tabStop) return null;
    const reach = tabAdvance(x, style.tabStop);
    return passed && x + reach + after(false) > right ? 0 : reach;
  }
  function onAutoTabRight(style, reach, right, after) {
    return style.autoTabRight && Math.abs(reach - Math.trunc(right)) < 1e-6 && !after();
  }
  function widthAfterTab(text, tab, fontPt, style, sizes, styles, advances, point) {
    let stop = text.indexOf('\t', tab + 1);
    if (stop < 0) stop = text.length;
    if (point) {
      let dot = -1;
      for (let i = stop - 1; i > tab; i--) if (text[i] === '.') { dot = i; break; }
      if (dot >= 0) stop = dot;
    }
    let width = 0;
    for (let i = tab + 1; i < stop; i++) {
      const fixed = advances ? advances.get(i) : undefined;
      width += fixed !== undefined ? fixed : charAdvance(text[i], sizes ? sizes[i] : fontPt, styles ? styles[i] : style);
    }
    return width;
  }
  const isAsciiAlpha = (c) => /^[A-Za-z]$/.test(c);
  const isAsciiDigit = (c) => /^[0-9]$/.test(c);
  function autoSpaceGap(previous, ch, fontPt, style, look) {
    if (!(style.autoSpaceLatin || style.autoSpaceDigit)) return 0;
    for (const [hangul, other] of [[previous, ch], [ch, previous]]) {
      if (hangul >= '가' && hangul <= '힣' &&
        ((style.autoSpaceLatin && isAsciiAlpha(other)) || (style.autoSpaceDigit && isAsciiDigit(other)))) {
        const spacing = (look || style).spacing;
        const height = pyRound(fontPt * 100);
        const gap = height / 4;
        if (!spacing) return gap;
        const adv = charAdvance(previous, fontPt, withoutSpacing(look || style));
        if (adv % LAYOUT_UNIT !== 0) return gap * (1 + spacing / 100);
        const units = adv / LAYOUT_UNIT;
        const quarter = Math.floor(Math.floor(height / LAYOUT_UNIT) / 4);
        return gap + (spacingUnits(units + quarter, spacing) - spacingUnits(units, spacing)) * LAYOUT_UNIT;
      }
    }
    return 0;
  }
  function spills(ch, previous) {
    if (ch === GLYPH_SPACE) return false;
    return ch === FIXED_SPACE || HANGING.has(previous);
  }
  function breakOpportunities(text, style) {
    const opp = [];
    for (let i = 1; i < text.length; i++) {
      const prev = text[i - 1], cur = text[i];
      if (HANGING.has(cur)) continue;
      if (HANGING.has(prev) || prev === '\t' || cur === '\t') { opp.push(i); continue; }
      const cp = classify(prev), cc = classify(cur);
      if (cp === 'hangul' || cp === 'wide' || cc === 'hangul' || cc === 'wide') {
        if (style.breakNonLatinWord === 'KEEP_WORD') opp.push(i);
        continue;
      }
      if (style.breakLatinWord === 'BREAK_WORD') opp.push(i);
    }
    return opp;
  }
  /** 한 줄(줄 바꿈 문자 없는) text가 각 줄을 어디서 시작하는지. widths[k]는 k번째 줄 폭(마지막 값 반복). */
  function hancomLineStarts(text, widths, fontPt, style, sizes, styles, advances, objects, continued) {
    sizes = sizes || null; styles = styles || null; advances = advances || null; objects = objects || new Set();
    const breaks = breakOpportunities(text, style);
    const unspaced = withoutSpacing(style);
    const space = charAdvance(' ', fontPt, unspaced);
    const starts = [0];
    const length = text.length;
    let start = 0;
    for (; ;) {
      const width = widths[Math.min(starts.length - 1, widths.length - 1)];
      const origin = lineOrigin(style, starts.length === 1 && !continued);
      let end = start, used = 0, inner = 0, pending = 0, seen = false, spilled = false, full = false;
      while (end < length) {
        const ch = text[end];
        const size = sizes === null ? fontPt : sizes[end];
        const look = styles === null ? style : styles[end];
        let fixed = advances === null ? undefined : advances.get(end);
        if (fixed === undefined && ch === '\t' && (style.tabStop || style.tabStops.length || style.autoTabRight)) {
          const at = end;
          const r = tabReach(origin + used, origin + width, style,
            (point) => widthAfterTab(text, at, fontPt, style, sizes, styles, advances, point));
          if (r !== null) fixed = r;
        }
        const advance = fixed === undefined ? charAdvance(ch, size, look) : fixed;
        if (HANGING.has(ch)) {
          if (used >= width && end > start && spills(ch, text[end - 1]) &&
            !(ch === text[end - 1] && ch === ' ' && end - 2 >= start &&
              (objects.has(end - 2) || !(HANGING.has(text[end - 2]) || text[end - 2] === OBJ_CHAR)))) {
            spilled = true;
            break;
          }
          if (seen && used >= width) full = true;
          used += advance;
          if (seen && ch !== FIXED_SPACE && ch !== GLYPH_SPACE) {
            pending += sizes === null && styles === null ? 1 : charAdvance(' ', size, withoutSpacing(look)) / space;
          }
          end++;
          continue;
        }
        if (full) break;
        const shrink = (inner + pending) * space * style.condense / 100;
        const last = fixed !== undefined ? fixed : charAdvance(ch, size, styles === null ? unspaced : withoutSpacing(look));
        const gap = end + 1 < length ? autoSpaceGap(ch, text[end + 1], size, style, look) : 0;
        const at = end;
        if ((used + last + gap - shrink > width || (ch === '\t' && used + last >= width &&
          !onAutoTabRight(style, origin + used + last, origin + width,
            () => widthAfterTab(text, at, fontPt, style, sizes, styles, advances, false)))) && end > start) break;
        used += advance + gap;
        inner += pending;
        pending = 0;
        seen = true;
        end++;
      }
      if (end >= length) return starts;
      if (spilled) start = end;
      else {
        let best = -1;
        for (const index of breaks) {
          if (start < index && index <= end &&
            (!NO_LINE_START.has(text[index]) || HANGING.has(text[index - 1]) || text[index - 1] === '\t') &&
            !NO_LINE_END.has(text[index - 1])) best = Math.max(best, index);
          if (start < index - 1 && index <= end && OPENING_MOVES_DOWN.has(text[index - 1]) &&
            !NO_LINE_END.has(text[index - 2]) && !NO_LINE_START.has(text[index])) best = Math.max(best, index - 1);
        }
        start = best >= 0 ? best : end;
        while (start < length && HANGING.has(text[start])) start++;
      }
      if (start >= length) return starts;
      starts.push(start);
    }
  }

  /** 줄 바꿈 문자로 나눈 각 조각을 따로 나누어 문단 전체의 줄 시작 위치를 돌려준다(_Measure.line_starts). */
  function lineStarts(text, widths, size, style, sizes, styles, advances, objects) {
    const starts = [];
    let base = 0, number = 0;
    let i = 0;
    while (i <= text.length) {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      const line = text.slice(i, j);
      const room = number === 0 ? widths : (widths.slice(1).length ? widths.slice(1) : widths);
      if (line.length) {
        const points = sizes ? sizes.slice(i, j).map((h) => h / 100) : null;
        const looks = styles ? styles.slice(i, j) : null;
        let fixed = null;
        if (advances) {
          fixed = new Map();
          for (const [k, v] of advances) if (k >= i && k < j) fixed.set(k - i, v);
        }
        const placed = new Set();
        if (objects) for (const k of objects) if (k >= i && k < j) placed.add(k - i);
        for (const s of hancomLineStarts(line, room, size / 100, style, points, looks, fixed, placed, number > 0)) starts.push(base + s);
      } else starts.push(base);
      base = j + 1;
      i = j + 1;
      number++;
      if (j >= text.length) break;
    }
    return starts;
  }

  function pitch(kind, value, size) {
    if (kind === 'FIXED') return value;
    if (kind === 'BETWEEN_LINES') return size + value;
    if (kind === 'AT_LEAST') return Math.max(size, value);
    const extra = Math.floor(size / 4) * (value - 100) / 100;
    const units = Math.floor(Math.abs(extra) + 0.5);
    return size + 4 * (extra >= 0 ? units : -units);
  }

  // ------------------------------------------------------------------ XML 도우미
  const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
  const kid = (el, name) => {
    if (!el) return null;
    for (const c of el.children) if (c.localName === name) return c;
    return null;
  };
  const num = (v, d = 0) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const signed32 = (v) => (v >= 2 ** 31 ? v - 2 ** 32 : v);
  const on = (v) => v === '1' || v === 'true';
  function descendants(el, name) {
    return el ? Array.from(el.getElementsByTagName('*')).filter((c) => c.localName === name) : [];
  }
  function firstDesc(el, name) {
    if (!el) return null;
    for (const c of el.getElementsByTagName('*')) if (c.localName === name) return c;
    return null;
  }
  function mmToHwp(s) {
    const m = /([-\d.]+)\s*(mm|cm|pt|in)?/.exec(String(s || '0'));
    if (!m) return 0;
    const v = parseFloat(m[1]);
    switch (m[2]) {
      case 'cm': return v * 10 * HWP_PER_MM;
      case 'pt': return v * 100;
      case 'in': return v * 7200;
      default: return v * HWP_PER_MM;
    }
  }
  function colorOf(v, fallback) {
    if (!v || v === 'none') return fallback === undefined ? null : fallback;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
    if (/^#[0-9a-fA-F]{8}$/.test(v)) return '#' + v.slice(3).toUpperCase(); // #AARRGGBB
    return fallback === undefined ? null : fallback;
  }

  // ------------------------------------------------------------------ 꾸러미 읽기
  async function readPackage(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      const e = new Error('구형 한글 파일(.hwp)입니다. 한글에서 hwpx로 저장한 파일을 열어 주세요.');
      e.code = 'HWP5';
      throw e;
    }
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const e = new Error('hwpx 파일이 아닙니다. 한글 문서(.hwpx)를 골라 주세요.');
      e.code = 'NOT_ZIP';
      throw e;
    }
    let zip;
    try {
      zip = await global.JSZip.loadAsync(buffer);
    } catch (err) {
      const e = new Error('파일 압축을 풀지 못했습니다. 손상되었거나 hwpx가 아닌 파일입니다.');
      e.code = 'BAD_ZIP';
      throw e;
    }
    const parser = new DOMParser();
    const readXml = async (path) => {
      const f = zip.file(path);
      if (!f) return null;
      const text = await f.async('string');
      const xml = parser.parseFromString(text, 'application/xml');
      if (xml.getElementsByTagName('parsererror').length) throw new Error(path + ' XML을 읽지 못했습니다');
      return xml.documentElement;
    };
    const names = Object.keys(zip.files);
    if (names.some((n) => /^(Scripts|DocInfo)\//.test(n)) && !names.includes('Contents/header.xml')) {
      const e = new Error('배포용·보안 문서라 열 수 없습니다.');
      e.code = 'DRM';
      throw e;
    }
    let content = null;
    const manifest = await readXml('Contents/content.hpf');
    const items = new Map();
    const spine = [];
    if (manifest) {
      for (const item of descendants(manifest, 'item')) items.set(item.getAttribute('id'), item);
      for (const ref of descendants(manifest, 'itemref')) spine.push(ref.getAttribute('idref'));
      content = manifest;
    }
    let headerPath = 'Contents/header.xml';
    const sectionPaths = [];
    for (const id of spine) {
      const item = items.get(id);
      if (!item) continue;
      const href = item.getAttribute('href');
      if (/header\.xml$/i.test(href)) headerPath = href;
      else if (/section\d*\.xml$/i.test(href)) sectionPaths.push(href);
    }
    if (!sectionPaths.length) {
      for (const n of names) if (/^Contents\/section\d+\.xml$/i.test(n)) sectionPaths.push(n);
      sectionPaths.sort((a, b) => num(/(\d+)\.xml$/i.exec(a)[1]) - num(/(\d+)\.xml$/i.exec(b)[1]));
    }
    const header = await readXml(headerPath);
    if (!header || !sectionPaths.length) {
      const encrypted = names.some((n) => /encryption/i.test(n));
      const e = new Error(encrypted ? '암호가 걸린 문서라 열 수 없습니다.' : '문서 본문을 찾지 못했습니다.');
      e.code = encrypted ? 'DRM' : 'NO_BODY';
      throw e;
    }
    const sections = [];
    for (const p of sectionPaths) sections.push(await readXml(p));
    const version = await readXml('version.xml');
    const bins = new Map();
    for (const [id, item] of items) {
      const href = item.getAttribute('href') || '';
      if (!/^BinData\//i.test(href)) continue;
      const f = zip.file(href);
      if (!f) continue;
      const type = item.getAttribute('media-type') || guessMime(href);
      const data = await f.async('uint8array');
      bins.set(id, { href, type, data });
    }
    for (const n of names) { // 목록에 없는 그림
      if (!/^BinData\//i.test(n)) continue;
      const id = n.replace(/^BinData\//i, '').replace(/\.[^.]+$/, '');
      if (!bins.has(id)) bins.set(id, { href: n, type: guessMime(n), data: await zip.file(n).async('uint8array') });
    }
    return { header, sections, version, bins, content };
  }
  function guessMime(name) {
    const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '';
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }[ext.toLowerCase()] || 'application/octet-stream';
  }

  // ------------------------------------------------------------------ 머리 정보(header.xml)
  const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const LANG_ATTR = { HANGUL: 'hangul', LATIN: 'latin', HANJA: 'hanja', JAPANESE: 'japanese', OTHER: 'other', SYMBOL: 'symbol', USER: 'user' };
  function langValues(el) {
    const o = {};
    if (!el) return o;
    for (const l of LANGS) {
      const v = el.getAttribute(LANG_ATTR[l]);
      if (v !== null) o[LANG_ATTR[l]] = num(v);
    }
    return o;
  }
  function parseHeader(root, version) {
    const H = { fonts: {}, charPr: new Map(), paraPr: new Map(), borderFill: new Map(), tabPr: new Map(), numbering: new Map(), bullet: new Map(), style: new Map() };
    const xmlVersion = version ? parseFloat(version.getAttribute('xmlVersion') || '') : NaN;
    H.doubled = Number.isFinite(xmlVersion) && xmlVersion < 1.31;
    for (const ff of descendants(root, 'fontface')) {
      const lang = ff.getAttribute('lang');
      const map = {};
      for (const f of kids(ff, 'font')) {
        const sub = kid(f, 'substFont');
        map[f.getAttribute('id')] = { face: f.getAttribute('face') || '', subst: sub ? sub.getAttribute('face') : null };
      }
      H.fonts[lang] = map;
    }
    for (const el of descendants(root, 'charPr')) {
      const fr = kid(el, 'fontRef');
      const u = kid(el, 'underline'), s = kid(el, 'strikeout');
      const cp = {
        id: el.getAttribute('id'),
        height: num(el.getAttribute('height'), 1000),
        textColor: colorOf(el.getAttribute('textColor'), '#000000'),
        shadeColor: colorOf(el.getAttribute('shadeColor')),
        useFontSpace: on(el.getAttribute('useFontSpace')),
        fontRef: {},
        ratio: langValues(kid(el, 'ratio')),
        spacing: langValues(kid(el, 'spacing')),
        relSz: langValues(kid(el, 'relSz')),
        offset: langValues(kid(el, 'offset')),
        bold: !!kid(el, 'bold'),
        italic: !!kid(el, 'italic'),
        supscript: !!kid(el, 'supscript'),
        subscript: !!kid(el, 'subscript'),
        underline: u && u.getAttribute('type') && u.getAttribute('type') !== 'NONE'
          ? { type: u.getAttribute('type'), shape: u.getAttribute('shape') || 'SOLID', color: colorOf(u.getAttribute('color'), null) } : null,
        strike: s && s.getAttribute('shape') && s.getAttribute('shape') !== 'NONE'
          ? { shape: s.getAttribute('shape'), color: colorOf(s.getAttribute('color'), null) } : null,
      };
      if (fr) for (const l of LANGS) cp.fontRef[LANG_ATTR[l]] = fr.getAttribute(LANG_ATTR[l]);
      H.charPr.set(cp.id, cp);
    }
    for (const el of descendants(root, 'borderFill')) {
      const side = (name) => {
        const b = kid(el, name);
        if (!b) return null;
        const type = b.getAttribute('type') || 'NONE';
        return { type, width: mmToHwp(b.getAttribute('width') || '0.1 mm'), color: colorOf(b.getAttribute('color'), '#000000') };
      };
      let fill = null;
      const brush = firstDesc(el, 'fillBrush');
      if (brush) {
        const win = kid(brush, 'winBrush');
        const grad = kid(brush, 'gradation');
        if (win) {
          const face = colorOf(win.getAttribute('faceColor'));
          const alpha = num(win.getAttribute('alpha'), 0);
          if (face) fill = { color: face, alpha: alpha ? 1 - alpha / 255 : 1, hatch: win.getAttribute('hatchStyle'), hatchColor: colorOf(win.getAttribute('hatchColor')) };
        } else if (grad) {
          const colors = kids(grad, 'color').map((c) => colorOf(c.getAttribute('value'))).filter(Boolean);
          if (colors.length) fill = { color: colors[0], gradient: colors, angle: num(grad.getAttribute('angle')), gradType: grad.getAttribute('type') };
        }
      }
      const slash = kid(el, 'slash'), back = kid(el, 'backSlash');
      H.borderFill.set(el.getAttribute('id'), {
        left: side('leftBorder'), right: side('rightBorder'), top: side('topBorder'), bottom: side('bottomBorder'),
        diagonal: side('diagonal'), slash: slash && slash.getAttribute('type') !== 'NONE' ? slash.getAttribute('type') : null,
        backSlash: back && back.getAttribute('type') !== 'NONE' ? back.getAttribute('type') : null, fill,
      });
    }
    for (const el of descendants(root, 'tabPr')) {
      const switchCase = firstDesc(el, 'case');
      const holder = switchCase && kids(switchCase, 'tabItem').length ? switchCase : el;
      let itemsEls = kids(holder, 'tabItem');
      if (!itemsEls.length) itemsEls = descendants(el, 'tabItem');
      const half = H.doubled && holder === el ? 2 : 1;
      H.tabPr.set(el.getAttribute('id'), {
        autoTabLeft: on(el.getAttribute('autoTabLeft')),
        autoTabRight: on(el.getAttribute('autoTabRight')),
        stops: itemsEls.map((t) => [Math.floor(num(t.getAttribute('pos')) / half), (t.getAttribute('type') || 'LEFT').toUpperCase(), t.getAttribute('leader') || 'NONE'])
          .sort((a, b) => a[0] - b[0]),
      });
    }
    for (const el of descendants(root, 'numbering')) {
      const heads = {};
      for (const h of kids(el, 'paraHead')) heads[num(h.getAttribute('level'), 1)] = paraHeadOf(h);
      H.numbering.set(el.getAttribute('id'), { start: num(el.getAttribute('start'), 1), heads });
    }
    for (const el of descendants(root, 'bullet')) {
      const h = kid(el, 'paraHead');
      H.bullet.set(el.getAttribute('id'), { char: el.getAttribute('char') || '●', useImage: on(el.getAttribute('useImage')), head: h ? paraHeadOf(h) : null });
    }
    for (const el of descendants(root, 'style')) {
      H.style.set(el.getAttribute('id'), { paraPr: el.getAttribute('paraPrIDRef'), charPr: el.getAttribute('charPrIDRef'), name: el.getAttribute('name') });
    }
    const st0 = H.style.get('0');
    const cp0 = st0 ? H.charPr.get(st0.charPr) : null;
    H.charUnitHeight = cp0 ? cp0.height : 1000;
    for (const el of descendants(root, 'paraPr')) H.paraPr.set(el.getAttribute('id'), parseParaPr(el, H));
    const begin = firstDesc(root, 'beginNum');
    H.beginNum = { page: num(begin && begin.getAttribute('page'), 1), footnote: num(begin && begin.getAttribute('footnote'), 1) };
    return H;
  }
  function paraHeadOf(h) {
    const attrs = {};
    for (const a of h.attributes) attrs[a.localName] = a.value;
    return { attrs, text: h.textContent || '', level: num(h.getAttribute('level'), 1), numFormat: h.getAttribute('numFormat') || 'DIGIT', start: num(h.getAttribute('start'), 1), charPr: h.getAttribute('charPrIDRef') };
  }
  function parseParaPr(el, H) {
    let caseEl = null;
    for (const c of descendants(el, 'case')) if (kid(c, 'lineSpacing')) { caseEl = c; break; }
    const holder = caseEl || el;
    let marginEl = kid(holder, 'margin');
    let spacingEl = kid(holder, 'lineSpacing');
    if (!marginEl && !caseEl) { // hp:switch 안의 hp:default만 있는 경우
      const def = firstDesc(el, 'default');
      if (def) { marginEl = kid(def, 'margin') || marginEl; spacingEl = kid(def, 'lineSpacing') || spacingEl; }
    }
    const half = H.doubled && !caseEl ? 2 : 1;
    const value = (name) => {
      const m = marginEl ? kid(marginEl, name) : null;
      if (!m) return 0;
      const v = num(m.getAttribute('value'));
      if (m.getAttribute('unit') === 'CHAR') return Math.floor(Math.trunc(v * H.charUnitHeight / 200) / half);
      return Math.floor(v / half);
    };
    let kind = 'PERCENT', amount = 160;
    if (spacingEl) {
      kind = spacingEl.getAttribute('type') || 'PERCENT';
      amount = num(spacingEl.getAttribute('value'), 160);
      if (kind !== 'PERCENT') amount = Math.floor(amount / half);
    }
    const align = kid(el, 'align');
    const heading = kid(el, 'heading');
    const bs = kid(el, 'breakSetting');
    const auto = kid(el, 'autoSpacing');
    const border = kid(el, 'border');
    return {
      id: el.getAttribute('id'),
      align: align ? (align.getAttribute('horizontal') || 'JUSTIFY') : 'JUSTIFY',
      heading: heading ? { type: heading.getAttribute('type') || 'NONE', idRef: heading.getAttribute('idRef') || '0', level: num(heading.getAttribute('level')) } : { type: 'NONE' },
      breakLatinWord: (bs && bs.getAttribute('breakLatinWord')) || 'KEEP_WORD',
      breakNonLatinWord: (bs && bs.getAttribute('breakNonLatinWord')) || 'BREAK_WORD',
      widowOrphan: bs ? on(bs.getAttribute('widowOrphan')) : false,
      keepWithNext: bs ? on(bs.getAttribute('keepWithNext')) : false,
      keepLines: bs ? on(bs.getAttribute('keepLines')) : false,
      pageBreakBefore: bs ? on(bs.getAttribute('pageBreakBefore')) : false,
      lineWrap: (bs && bs.getAttribute('lineWrap')) || 'BREAK',
      autoSpaceLatin: auto ? on(auto.getAttribute('eAsianEng')) : false,
      autoSpaceDigit: auto ? on(auto.getAttribute('eAsianNum')) : false,
      condense: num(el.getAttribute('condense')),
      fontLineHeight: on(el.getAttribute('fontLineHeight')),
      tabPr: el.getAttribute('tabPrIDRef') || '0',
      kind, value: amount,
      prev: value('prev'), next: value('next'), left: value('left'), right: value('right'), indent: value('intent'),
      border: border ? {
        bf: border.getAttribute('borderFillIDRef'), connect: on(border.getAttribute('connect')), ignoreMargin: on(border.getAttribute('ignoreMargin')),
        offsets: [num(border.getAttribute('offsetLeft')), num(border.getAttribute('offsetRight')), num(border.getAttribute('offsetTop')), num(border.getAttribute('offsetBottom'))],
      } : null,
    };
  }

  function fontFace(H, cp, langAttr) {
    if (!cp) return undefined;
    const lang = Object.keys(LANG_ATTR).find((k) => LANG_ATTR[k] === langAttr);
    const id = cp.fontRef[langAttr];
    const map = H.fonts[lang];
    if (id === undefined || id === null || !map || !map[id]) return undefined;
    return map[id].face;
  }

  /** 글자 모양 하나가 글자 폭을 정할 때 쓰는 값(look). 같은 값이면 같은 객체를 돌려준다. */
  function charLook(ctx, cpId) {
    const key = String(cpId);
    let look = ctx.looks.get(key);
    if (look) return look;
    const H = ctx.H;
    const cp = H.charPr.get(key);
    if (!cp) {
      look = makeStyle({});
    } else {
      const ratio = cp.ratio.hangul !== undefined ? cp.ratio.hangul : 100;
      const spacing = cp.spacing.hangul !== undefined ? cp.spacing.hangul : 0;
      const scripts = [];
      for (const name of ['latin', 'symbol', 'hanja']) {
        const r = cp.ratio[name] !== undefined ? cp.ratio[name] : ratio;
        const s = cp.spacing[name] !== undefined ? cp.spacing[name] : spacing;
        if (r !== ratio || s !== spacing) scripts.push([name, r, s]);
      }
      const hangulFace = fontFace(H, cp, 'hangul') || '';
      const faces = new Set(['hangul', 'latin', 'other', 'symbol'].map((l) => fontFace(H, cp, l)));
      look = makeStyle({
        ratio, spacing, scripts, useFontSpace: cp.useFontSpace, bold: cp.bold, italic: cp.italic,
        scriptSize: cp.supscript || cp.subscript ? SUPSUB_SIZE : 1,
        hangulFace, glyphFace: faces.size === 1 ? hangulFace : '',
        latinFace: fontFace(H, cp, 'latin') || '', symbolFace: fontFace(H, cp, 'symbol') || '',
      });
    }
    const sig = lookSignature(look);
    const same = ctx.lookBySig.get(sig);
    if (same) look = same; else ctx.lookBySig.set(sig, look);
    ctx.looks.set(key, look);
    return look;
  }
  function lookSignature(l) {
    return [l.ratio, l.spacing, JSON.stringify(l.scripts), l.useFontSpace, l.bold, l.italic, l.scriptSize, l.hangulFace, l.glyphFace, l.latinFace, l.symbolFace].join('|');
  }
  /** 문단 모양과 첫 글자 모양으로 만든 문단의 배치 값(text_style_from_refs). */
  function paraStyle(ctx, ppId, cpId, label) {
    const key = ppId + '\u0001' + cpId + '\u0001' + (label ? label.key : '');
    let st = ctx.paraStyles.get(key);
    if (st) return st;
    const pp = ctx.H.paraPr.get(String(ppId));
    const look = charLook(ctx, cpId);
    if (!pp) {
      st = Object.assign({}, look);
    } else {
      const tab = ctx.H.tabPr.get(pp.tabPr);
      st = Object.assign({}, look, {
        breakLatinWord: pp.breakLatinWord, breakNonLatinWord: pp.breakNonLatinWord, lineWrap: pp.lineWrap,
        condense: pp.condense, indent: pp.indent, marginLeft: pp.left, marginRight: pp.right, spaceBefore: pp.prev,
        tabStops: tab ? tab.stops.map((s) => [s[0], s[1]]) : [], autoTabLeft: tab ? tab.autoTabLeft : false,
        autoTabRight: tab ? tab.autoTabRight : false, autoSpaceLatin: pp.autoSpaceLatin, autoSpaceDigit: pp.autoSpaceDigit,
        tabStop: ctx.tabStop,
      });
      if (label) { st.head = label.room; st.headHangs = label.hangs; }
    }
    ctx.paraStyles.set(key, st);
    return st;
  }

  // ------------------------------------------------------------------ 문단 읽기
  /** hp:t의 글자와, 한글이 줄 정보(textpos)에서 세는 글자 자리 수(탭 8, 나머지 1). */
  function tText(t) {
    let out = '';
    const widths = [];
    const push = (str, w) => { for (const ch of Array.from(str)) { out += ch; widths.push(w); } };
    for (const node of t.childNodes) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        for (const ch of Array.from(node.nodeValue.replace(/　/g, GLYPH_SPACE))) { out += ch; widths.push(ch.codePointAt(0) > 0xffff ? 2 : 1); }
      }
      else if (node.nodeType === 1) {
        switch (node.localName) {
          case 'lineBreak': push('\n', 1); break;
          case 'tab': push('\t', 8); break;
          case 'nbSpace': push(' ', 1); break;
          case 'fwSpace': push('　', 1); break;
          case 'titleMark': push('‍', 0); break;
          default: { const inner = node.textContent || ''; if (inner) push(inner, 1); break; }
        }
      }
    }
    return { text: out, widths };
  }
  function parseParagraph(p) {
    const para = { el: p, paraPr: p.getAttribute('paraPrIDRef') || '0', style: p.getAttribute('styleIDRef'), pageBreak: on(p.getAttribute('pageBreak')), columnBreak: on(p.getAttribute('columnBreak')), runs: [] };
    for (const run of kids(p, 'run')) {
      const r = { cp: run.getAttribute('charPrIDRef') || '0', items: [], el: run };
      const visit = (child) => {
        const name = child.localName;
        if (name === 't') { const tt = tText(child); r.items.push({ kind: 't', text: tt.text, hw: tt.widths, el: child }); }
        else if (OBJECT_TAGS.has(name)) r.items.push({ kind: 'obj', name, el: child });
        else if (name === 'ctrl') for (const c of child.children) r.items.push({ kind: 'ctrl', name: c.localName, el: c });
        else if (name === 'secPr') r.items.push({ kind: 'secPr', el: child });
        else if (name === 'switch') {
          const branch = kids(child, 'case').find((c) => /ooxmlchart/.test(c.getAttribute('hp:required-namespace') || c.getAttribute('required-namespace') || '')) || kid(child, 'default');
          if (branch) for (const c of branch.children) visit(c);
        } else if (name === 'compose' || name === 'dutmal') {
          const txt = name === 'compose' ? (child.getAttribute('composeText') || '') : (kid(child, 'mainText') ? kid(child, 'mainText').textContent : '');
          r.items.push({ kind: 't', text: txt, el: child, mark: name });
        }
      };
      for (const child of run.children) visit(child);
      para.runs.push(r);
    }
    const lsa = kid(p, 'linesegarray');
    if (lsa) {
      para.cache = kids(lsa, 'lineseg').map((g) => ({
        textpos: num(g.getAttribute('textpos'), -1), vertpos: num(g.getAttribute('vertpos')), vertsize: num(g.getAttribute('vertsize')),
        textheight: num(g.getAttribute('textheight'), num(g.getAttribute('vertsize'))), spacing: num(g.getAttribute('spacing')),
        horzpos: num(g.getAttribute('horzpos')), horzsize: num(g.getAttribute('horzsize')), flags: num(g.getAttribute('flags')),
      }));
    }
    return para;
  }

  // ------------------------------------------------------------------ 번호·글머리표(간단)
  const HANGUL_SYL = '가나다라마바사아자차카타파하';
  const HANGUL_JAMO = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
  function roman(n) {
    const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [a, s] of t) while (n >= a) { out += s; n -= a; }
    return out;
  }
  function numberText(n, fmt) {
    if (n <= 0) return String(n);
    switch (fmt) {
      case 'HANGUL_SYLLABLE': return HANGUL_SYL[(n - 1) % 14];
      case 'HANGUL_JAMO': return HANGUL_JAMO[(n - 1) % 14];
      case 'CIRCLED_DIGIT': return n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
      case 'CIRCLED_HANGUL_SYLLABLE': return String.fromCodePoint(0x326e + (n - 1) % 14);
      case 'CIRCLED_HANGUL_JAMO': return String.fromCodePoint(0x3260 + (n - 1) % 14);
      case 'ROMAN_CAPITAL': return roman(n);
      case 'ROMAN_SMALL': return roman(n).toLowerCase();
      case 'LATIN_CAPITAL': return String.fromCharCode(65 + (n - 1) % 26);
      case 'LATIN_SMALL': return String.fromCharCode(97 + (n - 1) % 26);
      case 'CIRCLED_LATIN_SMALL': return String.fromCodePoint(0x24d0 + (n - 1) % 26);
      default: return String(n);
    }
  }
  /** 문단 머리(글머리표·번호)의 글자와 자리. 읽는 차례대로 번호를 센다. */
  function paragraphLabel(ctx, para) {
    const pp = ctx.H.paraPr.get(para.paraPr);
    if (!pp || !pp.heading || !['BULLET', 'NUMBER', 'OUTLINE'].includes(pp.heading.type)) return null;
    let text = '', head = null;
    if (pp.heading.type === 'BULLET') {
      const b = ctx.H.bullet.get(pp.heading.idRef);
      if (!b || !b.head) return null;
      text = b.useImage ? '●' : (b.char || '●').slice(0, 1);
      head = b.head;
    } else {
      let ref = pp.heading.idRef;
      if (pp.heading.type === 'OUTLINE' && (ref === '0' || !ref)) ref = ctx.outlineRef || '1';
      const numbering = ctx.H.numbering.get(ref);
      const level = pp.heading.level + 1;
      if (!numbering || !numbering.heads[level]) return null;
      head = numbering.heads[level];
      const counters = ctx.counters[ref] || (ctx.counters[ref] = {});
      const startOf = (lv) => (numbering.heads[lv] ? numbering.heads[lv].start : 1);
      counters[level] = counters[level] === undefined ? startOf(level) : counters[level] + 1;
      for (const k of Object.keys(counters)) if (+k > level) delete counters[k];
      for (let lv = 1; lv < level; lv++) if (counters[lv] === undefined) counters[lv] = startOf(lv);
      text = head.text.replace(/\^(\d+|N)/g, (m, key) => {
        if (key === 'N') { let s = ''; for (let lv = 1; lv <= level; lv++) s += counters[lv] + '.'; return s; }
        const lv = +key;
        const h = numbering.heads[lv];
        return numberText(counters[lv] || 1, h ? h.numFormat : 'DIGIT');
      });
      if (!text) return null;
    }
    return { text, head };
  }

  // ------------------------------------------------------------------ 문단 배치
  /** 문단 글자 줄을 만든다. 표·그림처럼 글자로 취급하는 개체는 U+FFFC 자리로 넣는다. */
  function paraContent(ctx, para) {
    const text = [], sizes = [], cps = [], marks = [], src = [], hpos = [];
    let hp = 0; // 한글이 세는 글자 자리
    const objects = new Map(); // index -> {item, width, height}
    const placed = []; // 글자처럼 취급하지 않는 개체
    const notes = []; // {offset, el, kind}
    const ctrls = [];
    let hasText = false;
    for (const run of para.runs) {
      const height = charHeight(ctx, run.cp);
      for (const it of run.items) {
        if (it.kind === 't') {
          const chars = Array.from(it.text);
          chars.forEach((ch, k) => {
            text.push(ch); sizes.push(height); cps.push(run.cp); marks.push(null); src.push('t'); hpos.push(hp);
            hp += it.hw ? it.hw[k] : 1;
          });
          if (it.text.length) hasText = true;
        } else if (it.kind === 'obj') {
          const pos = kid(it.el, 'pos');
          const tac = pos ? on(pos.getAttribute('treatAsChar')) : false;
          const wrap = it.el.getAttribute('textWrap') || 'TOP_AND_BOTTOM';
          const obj = { item: it, el: it.el, name: it.name, tac, floating: FLOATING.has(wrap), wrap, pos, cp: run.cp };
          if (tac && !obj.floating) {
            Object.assign(obj, objectExtent(ctx, it.el, it.name));
            objects.set(text.length, obj);
            text.push(OBJ_CHAR); sizes.push(height); cps.push(run.cp); marks.push({ obj }); src.push('obj'); hpos.push(hp);
          } else placed.push(obj);
          hp += 8;
        } else if (it.kind === 'ctrl') {
          if (it.name === 'footNote' || it.name === 'endNote') {
            const numberValue = num(it.el.getAttribute('number'), 0) || ++ctx.noteCounter[it.name];
            if (num(it.el.getAttribute('number'), 0)) ctx.noteCounter[it.name] = numberValue;
            const suffix = it.el.getAttribute('suffixChar');
            const fmt = ctx.section && ctx.section[it.name === 'footNote' ? 'footNote' : 'endNote'];
            const mark = (fmt ? fmt.prefix : '') + numberText(numberValue, fmt ? fmt.type : 'DIGIT') + (suffix ? String.fromCharCode(num(suffix)) : (fmt ? fmt.suffix : ')'));
            notes.push({ offset: text.length, el: it.el, kind: it.name, number: numberValue, mark });
            for (const ch of Array.from(mark)) { text.push(ch); sizes.push(height); cps.push(run.cp); marks.push({ sup: true }); src.push('note'); hpos.push(hp); }
            hp += 8;
          } else if (it.name === 'autoNum') {
            const type = it.el.getAttribute('numType') || 'PAGE';
            const fmtEl = kid(it.el, 'autoNumFormat');
            const value = num(it.el.getAttribute('num'), 1);
            const fmt = fmtEl ? { type: fmtEl.getAttribute('type') || 'DIGIT', prefix: fmtEl.getAttribute('prefixChar') || '', suffix: fmtEl.getAttribute('suffixChar') || '', sup: on(fmtEl.getAttribute('supscript')) } : { type: 'DIGIT', prefix: '', suffix: '', sup: false };
            const label = type === 'PAGE' ? '\u0000' : fmt.prefix + numberText(value, fmt.type) + fmt.suffix;
            if (type === 'PAGE') { // 쪽 번호: 그릴 때 채운다
              text.push('1'); sizes.push(height); cps.push(run.cp); marks.push({ page: true, fmt }); src.push('page'); hpos.push(hp);
            } else {
              for (const ch of Array.from(label)) { text.push(ch); sizes.push(height); cps.push(run.cp); marks.push(fmt.sup ? { sup: true } : null); src.push('auto'); hpos.push(hp); }
            }
            hp += 8;
          } else { ctrls.push({ name: it.name, el: it.el, cp: run.cp }); hp += 8; }
        } else if (it.kind === 'secPr') { ctrls.push({ name: 'secPr', el: it.el, cp: run.cp }); hp += 8; }
      }
    }
    return { text, sizes, cps, marks, src, hpos, hlen: hp, objects, placed, notes, ctrls, hasText };
  }
  function charHeight(ctx, cpId) {
    const cp = ctx.H.charPr.get(String(cpId));
    return cp ? cp.height : 1000;
  }

  /** 문단 하나의 줄들을 width 폭에서 배치한다. 본문·표 칸·각주에 함께 쓴다. */
  function layoutParagraph(ctx, para, width, opts) {
    opts = opts || {};
    const H = ctx.H;
    const pp = H.paraPr.get(para.paraPr) || parseParaPrDefault();
    const content = paraContent(ctx, para);
    const label = paragraphLabel(ctx, para);
    const runsWithText = para.runs.filter((r) => r.items.some((i) => i.kind === 't' && i.text.length));
    const refs = runsWithText.length ? runsWithText.map((r) => r.cp)
      : (para.runs.filter((r) => r.items.some((i) => i.kind === 't')).map((r) => r.cp));
    const firstRef = refs.length ? refs[0] : (para.runs.length ? para.runs[0].cp : '0');
    let labelInfo = null;
    if (label) {
      const own = label.head.charPr && label.head.charPr !== '4294967295' && H.charPr.has(label.head.charPr) ? label.head.charPr : (para.runs.length ? para.runs[para.runs.length - 1].cp : firstRef);
      const em = charHeight(ctx, own);
      labelInfo = { text: label.text, cp: own, em, room: labelRoom(label.text, label.head.attrs, em, charLook(ctx, own)), hangs: on(label.head.attrs.autoIndent), key: label.text + '|' + own };
    }
    const style = paraStyle(ctx, para.paraPr, firstRef, labelInfo);
    const textSizes = content.sizes.filter((_, i) => !content.marks[i] || !content.marks[i].obj);
    const realText = content.text.filter((c, i) => !(content.marks[i] && content.marks[i].obj)).join('');
    // 문단 글자 크기(가장 작은 것)
    let size;
    if (textSizes.length) size = Math.min(...textSizes);
    else {
      const held = para.runs.slice(0, -1).filter((r) => r.items.some((i) => i.kind !== 't')).map((r) => r.cp);
      if (para.runs.length) held.push(para.runs[para.runs.length - 1].cp);
      size = held.length ? Math.max(...held.map((c) => charHeight(ctx, c))) : 1000;
      if (labelInfo) size = Math.max(size, labelInfo.em);
    }
    const lay = {
      para, pp, style, content, label: labelInfo, size, width,
      prev: pp.prev, next: pp.next, lines: [], flowTable: null, anchored: null, floating: [], notes: new Map(),
      keepNext: pp.keepWithNext, keepLines: pp.keepLines, widowOrphan: pp.widowOrphan, breakBefore: pp.pageBreakBefore,
      pageBreak: para.pageBreak, columnBreak: para.columnBreak,
    };
    const objectsInline = content.objects;
    const placed = content.placed.filter((o) => !o.floating);
    lay.floating = content.placed.filter((o) => o.floating).map((o) => Object.assign(o, objectExtent(ctx, o.el, o.name)));
    for (const o of lay.floating) o.layout = o.layout || null;
    const onlyObject = objectsInline.size === 1 && !realText.length && !placed.length;
    // 줄 폭
    const widths = indented(width - pp.left - pp.right, pp, style);
    lay.widths = widths;
    const sizePitch = pitch(pp.kind, pp.value, size);
    if (onlyObject) {
      // 글자처럼 취급한 개체 하나뿐인 문단: 개체만큼 높은 줄 하나
      const obj = objectsInline.values().next().value;
      const sizeAll = Math.max(...para.runs.map((r) => charHeight(ctx, r.cp)));
      let tall = Math.max(obj.height, sizeAll);
      const affect = obj.pos && on(obj.pos.getAttribute('affectLSpacing'));
      const adv = pp.kind === 'PERCENT' && !affect ? tall + pitch(pp.kind, pp.value, sizeAll) - sizeAll : pitch(pp.kind, pp.value, tall);
      const line = { start: 0, end: content.text.length, height: tall, advance: adv, textSize: sizeAll, objOnly: true };
      lay.lines.push(line);
      lay.size = tall;
      buildLineGlyphs(ctx, lay, 0);
      return finishNotes(ctx, lay, opts);
    }
    if (placed.length && !content.hasText && !objectsInline.size) {
      const obj = placed[0];
      const sizeAll = Math.max(...para.runs.map((r) => charHeight(ctx, r.cp)), 100);
      const line = { start: 0, end: content.text.length, height: sizeAll, advance: pitch(pp.kind, pp.value, sizeAll), textSize: sizeAll };
      lay.lines.push(line);
      if (obj.name === 'tbl' && (obj.wrap === 'TOP_AND_BOTTOM' || obj.wrap === 'SQUARE')) {
        lay.flowTable = flowTableOf(ctx, obj);
      } else {
        const ext = objectExtent(ctx, obj.el, obj.name);
        lay.anchored = Object.assign(obj, ext);
        const offset = obj.pos ? signed32(num(obj.pos.getAttribute('vertOffset'))) : 0;
        const below = Math.max(offset, 0) + ext.height;
        line.height = Math.max(below, sizeAll);
        line.advance = Math.max(below, sizeAll) + (pitch(pp.kind, pp.value, sizeAll) - sizeAll);
        line.anchorTop = Math.max(offset, 0);
      }
      buildLineGlyphs(ctx, lay, 0);
      return finishNotes(ctx, lay, opts);
    }
    if (placed.length) {
      // 글 앞에 놓인 표·그림(위아래 배치): 글보다 먼저 자리를 잡고 글은 그 아래에 둔다(간단히)
      const obj = placed[0];
      if (obj.name === 'tbl') {
        const tl = layoutTable(ctx, obj.el);
        lay.anchored = Object.assign(obj, { width: tl.width + tl.out[0] + tl.out[1], height: tl.height + tl.out[2] + tl.out[3], layout: tl });
      } else lay.anchored = Object.assign(obj, objectExtent(ctx, obj.el, obj.name));
      for (const o of placed.slice(1)) lay.floating.push(Object.assign(o, objectExtent(ctx, o.el, o.name)));
    }
    // 글 줄
    const text = content.text;
    const looksArr = content.cps.map((c, i) => (content.marks[i] && content.marks[i].sup ? supLook(ctx, c) : charLook(ctx, c)));
    const distinct = new Set(looksArr);
    const looks = distinct.size > 1 ? looksArr : null;
    const allSame = content.sizes.every((s) => s === content.sizes[0]);
    const advances = new Map();
    const objIdx = new Set();
    for (const [i, o] of objectsInline) { advances.set(i, o.width); objIdx.add(i); }
    const endSize = endSizeOf(ctx, para, textSizes);
    const headSize = headSizeOf(ctx, para, textSizes, labelInfo);
    const mixed = !allSame || endSize || headSize || objectsInline.size || (pp.fontLineHeight && textSizes.length);
    let starts;
    const cached = !objectsInline.size && !content.placed.length ? cacheLines(para, content, pp) : null;
    if (cached) {
      lay.fromCache = true;
      for (const c of cached) { lay.lines.push(c); }
      for (let k = 0; k < lay.lines.length; k++) buildLineGlyphs(ctx, lay, k);
      return finishNotes(ctx, lay, opts);
    }
    if (!text.length) starts = [0];
    else if (pp.lineWrap === 'SQUEEZE' || opts.noWrap) starts = noWrapStarts(text);
    else starts = lineStarts(text, widths, size, looks ? style : (looksArr[0] ? mergeLook(style, looksArr[0]) : style),
      allSame ? null : content.sizes, looks, objectsInline.size ? advances : null, objIdx);
    const heights = content.sizes.map((s, i) => (pp.fontLineHeight ? fontLine(s, looksArr[i]) : s));
    const endH = pp.fontLineHeight ? fontLine(endSize, style) : endSize;
    const headH = pp.fontLineHeight ? fontLine(headSize, style) : headSize;
    for (let k = 0; k < starts.length; k++) {
      const start = starts[k], stop = k + 1 < starts.length ? starts[k + 1] : text.length;
      let lineH, adv, textSize;
      if (!text.length) {
        const s = pp.fontLineHeight ? fontLine(size, style) : size;
        lineH = s; adv = pitch(pp.kind, pp.value, s); textSize = s;
      } else if (!mixed) {
        lineH = size; adv = sizePitch; textSize = size;
      } else {
        const span = [];
        if (stop > start) for (let i = start; i < stop; i++) span.push(i); else span.push(text.length - 1);
        const edges = [];
        if (stop === text.length && endH) edges.push(endH);
        if (start === 0 && headH) edges.push(headH);
        const s = Math.max(...span.map((i) => heights[i]), ...edges);
        const glyphs = span.filter((i) => !objIdx.has(i)).map((i) => heights[i]).concat(edges);
        lineH = Math.max(glyphs.length ? Math.max(...glyphs) : s, ...span.filter((i) => objIdx.has(i)).map((i) => objectsInline.get(i).height));
        const p = pitch(pp.kind, pp.value, s);
        adv = pp.kind === 'FIXED' ? p : lineH + p - s;
        textSize = glyphs.length ? Math.max(...glyphs) : s;
      }
      lay.lines.push({ start, end: stop, height: lineH, advance: adv, textSize });
    }
    if (lay.anchored) {
      const a = lay.anchored;
      const offset = a.pos ? Math.max(signed32(num(a.pos.getAttribute('vertOffset'))), 0) : 0;
      lay.anchorBlock = offset + a.height;
    }
    for (let k = 0; k < lay.lines.length; k++) buildLineGlyphs(ctx, lay, k);
    return finishNotes(ctx, lay, opts);
  }
  /** 한글이 저장한 줄 정보(linesegarray)가 믿을 만하면 그 줄 시작·높이를 쓴다(_cached_metrics). */
  function cacheLines(para, content, pp) {
    const segs = para.cache;
    if (!segs || !segs.length || !content.text.length) return null;
    if (pp.lineWrap === 'SQUEEZE') return null;
    let prev = -1;
    for (const g of segs) {
      if (g.textpos < 0 || g.textpos < prev) return null;
      if ((g.textheight || g.vertsize) <= 0) return null;
      prev = g.textpos;
    }
    if (segs[0].textpos !== 0) return null;
    const total = content.hlen;
    for (const g of segs) if (g.textpos > total && !(g.textpos === total + 1 && (g.flags & 0x10000))) return null;
    // 마지막 줄 뒤 글이 그 줄 폭의 두 배를 넘게 길면 오래된 정보다
    const last = segs[segs.length - 1];
    let tailStart = content.hpos.findIndex((h) => h >= last.textpos);
    if (tailStart < 0) tailStart = content.text.length;
    const tail = content.text.slice(tailStart);
    if (tail.length >= 8 && last.horzsize > 0) {
      const em = (last.textheight || last.vertsize);
      let w = 0;
      for (const ch of tail) w += ADVANCE_EM[classify(ch)] * em;
      if (w > last.horzsize * 2) return null;
    }
    const lines = [];
    for (let k = 0; k < segs.length; k++) {
      const g = segs[k], next = segs[k + 1];
      let start = content.hpos.findIndex((h) => h >= g.textpos);
      if (start < 0) start = content.text.length;
      if (lines.length && start <= lines[lines.length - 1].start) continue;
      const height = g.textheight || g.vertsize;
      const beside = next && next.vertpos === g.vertpos && next.horzpos > g.horzpos;
      lines.push({ start, end: 0, height, advance: beside ? 0 : height + g.spacing, textSize: height, horz: [g.horzpos, g.horzsize] });
    }
    for (let k = 0; k < lines.length; k++) lines[k].end = k + 1 < lines.length ? lines[k + 1].start : content.text.length;
    return lines.length ? lines : null;
  }
  function fallbackLayout(para) {
    const pp = parseParaPrDefault();
    return { para, pp, style: makeStyle({}), content: { text: [], sizes: [], cps: [], marks: [], src: [], hpos: [], hlen: 0, objects: new Map(), placed: [], notes: [], ctrls: [], hasText: false },
      label: null, size: 1000, width: 0, prev: 0, next: 0, lines: [{ start: 0, end: 0, height: 1000, advance: 1600, textSize: 1000, glyphs: [], baseline: 850 }],
      flowTable: null, anchored: null, floating: [], notes: new Map(), keepNext: false, keepLines: false, widowOrphan: false, breakBefore: false,
      pageBreak: para.pageBreak, columnBreak: para.columnBreak, widths: [0, 0] };
  }
  function mergeLook(style, look) {
    // 모든 글자가 같은 모양이면 문단 값(style)은 첫 글자 모양으로 이미 만들어져 있다
    return style;
  }
  function parseParaPrDefault() {
    return { align: 'JUSTIFY', heading: { type: 'NONE' }, breakLatinWord: 'KEEP_WORD', breakNonLatinWord: 'BREAK_WORD', lineWrap: 'BREAK', condense: 0, kind: 'PERCENT', value: 160, prev: 0, next: 0, left: 0, right: 0, indent: 0, tabPr: '0', border: null };
  }
  function noWrapStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
  }
  function supLook(ctx, cpId) {
    const key = 'sup:' + cpId;
    let l = ctx.looks.get(key);
    if (!l) { l = Object.assign({}, charLook(ctx, cpId), { scriptSize: SUPSUB_SIZE }); ctx.looks.set(key, l); }
    return l;
  }
  function fontLine(size, style) {
    const face = style && style.hangulFace;
    const metrics = M.vmetrics[face || ''];
    if (!metrics || !size) return size;
    const [ascent, descent] = metrics;
    const upem = M.upem[face];
    if (ascent + descent === upem) return size;
    return Math.ceil(size * ascent / upem) + Math.ceil(size * descent / upem);
  }
  function endSizeOf(ctx, para, sizes) {
    const runs = para.runs;
    if (!runs.length || !sizes.length) return 0;
    const last = runs[runs.length - 1];
    if (last.items.some((i) => i.kind !== 't' || i.text.length)) return 0;
    const s = charHeight(ctx, last.cp);
    return s > Math.min(...sizes) ? s : 0;
  }
  function headSizeOf(ctx, para, sizes, label) {
    if (!sizes.length) return 0;
    let size = label ? label.em : 0;
    for (const run of para.runs) {
      if (run.items.some((i) => i.kind === 't' && i.text.length)) break;
      if (run.items.some((i) => i.kind === 'ctrl' || i.kind === 'secPr')) size = Math.max(size, charHeight(ctx, run.cp));
    }
    return size > Math.min(...sizes) ? size : 0;
  }
  function labelRoom(text, attrs, em, style) {
    if (!text) return 0;
    let width;
    const chars = Array.from(text);
    if (on(attrs.useInstWidth)) {
      width = chars.slice(0, -1).reduce((a, ch) => a + charAdvance(ch, em / 100, style), 0) + charAdvance(chars[chars.length - 1], em / 100, withoutSpacing(style));
    } else width = chars.reduce((a, ch) => a + (ch.codePointAt(0) < 0x80 ? em / 2 : em), 0);
    const offset = num(attrs.textOffset, 50);
    const gap = attrs.textOffsetType === 'HWPUNIT' ? offset : em * offset / 100;
    return width + num(attrs.widthAdjust, 0) + gap;
  }
  function indented(line, pp, style) {
    if (style && style.lineWrap === 'SQUEEZE') return [NO_WRAP, NO_WRAP];
    if (style && style.head) {
      if (style.headHangs) return [line - style.head, line - (style.head - pp.indent)];
      return [line - Math.max(pp.indent, 0) - style.head, line - Math.max(-pp.indent, 0)];
    }
    const rooms = [line - Math.max(pp.indent, 0), line - Math.max(-pp.indent, 0)];
    return Math.min(...rooms) < MIN_LINE_WIDTH ? [line, line] : rooms;
  }
  function finishNotes(ctx, lay, opts) {
    const notes = lay.content.notes;
    if (!notes.length || opts.noNotes) return lay;
    const starts = lay.lines.map((l) => l.start);
    for (const n of notes) {
      if (n.kind === 'endNote') {
        const sub = kid(n.el, 'subList');
        const paras = sub ? kids(sub, 'p').map(parseParagraph) : [];
        (lay.endnotes = lay.endnotes || []).push({ number: n.number, mark: n.mark, lays: paras.map((p) => layoutParagraph(ctx, p, ctx.columnWidth, { noNotes: true })) });
        continue;
      }
      let line = 0;
      for (let k = 0; k < starts.length; k++) if (starts[k] <= Math.max(n.offset - 1, 0)) line = k;
      const sub = kid(n.el, 'subList');
      const paras = sub ? kids(sub, 'p').map(parseParagraph) : [];
      const width = ctx.columnWidth;
      const noteLays = paras.map((p) => layoutParagraph(ctx, p, width, { noNotes: true }));
      const tall = stackHeight(noteLays);
      const first = noteLays.length && noteLays[0].lines.length ? charHeight(ctx, paras[0].runs.length ? paras[0].runs[0].cp : '0') : 0;
      const entry = lay.notes.get(line) || { height: 0, count: 0, first: 0, items: [] };
      entry.height += tall; entry.count += 1; entry.first = entry.first || first;
      entry.items.push({ number: n.number, mark: n.mark, kind: n.kind, lays: noteLays, height: tall });
      lay.notes.set(line, entry);
    }
    return lay;
  }
  /** 문단들을 위아래로 쌓은 높이(마지막 줄 아래 줄 간격은 빼고). */
  function stackHeight(lays) {
    let height = 0, pending = null;
    for (const l of lays) {
      if (pending !== null) height += pending + l.prev;
      const lines = l.lines;
      for (let k = 0; k < lines.length - 1; k++) height += lines[k].advance;
      const last = lines[lines.length - 1];
      height += last.height;
      pending = last.advance - last.height + l.next;
    }
    return height;
  }

  // ------------------------------------------------------------------ 줄 안의 글자 위치
  function buildLineGlyphs(ctx, lay, k) {
    const line = lay.lines[k];
    const { content, pp, style } = lay;
    const text = content.text;
    const first = k === 0;
    const lastLine = k === lay.lines.length - 1;
    const endsWithBreak = line.end > 0 && text[line.end - 1] === '\n';
    const widths = lay.widths;
    const avail = widths[Math.min(k, widths.length - 1)];
    // 줄 시작 위치(_line_origin). 들여쓰기가 너무 좁아 버려진 경우는 여백만.
    const dropped = !style.head && Math.min(lay.width - pp.left - pp.right - Math.max(pp.indent, 0), lay.width - pp.left - pp.right - Math.max(-pp.indent, 0)) < MIN_LINE_WIDTH;
    let origin;
    if (dropped) origin = pp.left;
    else if (style.head && style.headHangs) origin = pp.left + (first ? style.head : style.head - pp.indent);
    else origin = pp.left + (first ? Math.max(pp.indent, 0) + style.head : Math.max(-pp.indent, 0));
    const glyphs = [];
    let x = 0;
    let lastVisible = -1, firstVisible = -1;
    const sup = (i) => content.marks[i] && content.marks[i].sup;
    for (let i = line.start; i < line.end; i++) {
      const ch = text[i];
      if (ch === '\n') continue;
      const mark = content.marks[i];
      const look = sup(i) ? supLook(ctx, content.cps[i]) : charLook(ctx, content.cps[i]);
      const size = content.sizes[i];
      let adv;
      if (mark && mark.obj) adv = mark.obj.width;
      else if (ch === '\t') {
        const r = tabReach(origin + x, origin + avail, style, () => 0);
        adv = r === null ? charAdvance(' ', size / 100, look) : r;
      } else adv = charAdvance(ch, size / 100, look);
      const plain = mark && mark.obj ? adv : (ch === '\t' ? adv : charAdvance(ch, size / 100, withoutSpacing(look)));
      const g = { i, ch, x, adv, plain, size, cp: content.cps[i], look, sup: !!sup(i), obj: mark && mark.obj ? mark.obj : null, page: mark && mark.page ? mark : null };
      glyphs.push(g);
      x += adv;
      if (!HANGING.has(ch) && ch !== '\t') {
        lastVisible = glyphs.length - 1;
        if (firstVisible < 0) firstVisible = glyphs.length - 1;
      }
    }
    // 자연 폭: 마지막 보이는 글자까지(그 글자의 자간은 빼고)
    let natural = 0;
    if (lastVisible >= 0) {
      const g = glyphs[lastVisible];
      const plain = g.obj ? g.adv : (g.ch === '\t' ? g.adv : charAdvance(g.ch, g.size / 100, withoutSpacing(g.look)));
      natural = g.x + plain;
    }
    let align = pp.align;
    if (lay.forceAlign) align = lay.forceAlign;
    const isLast = lastLine || endsWithBreak;
    let remaining = avail - natural;
    if (avail >= NO_WRAP / 2) remaining = 0;
    // 줄 안쪽 빈칸(첫 글자 뒤, 마지막 글자 앞)
    const inner = [];
    if (firstVisible >= 0) for (let j = firstVisible + 1; j < lastVisible; j++) if (glyphs[j].ch === ' ' || glyphs[j].ch === ' ') inner.push(j);
    let x0 = 0;
    const shift = new Array(glyphs.length).fill(0);
    const spread = (amount, targets) => {
      if (!targets.length) return;
      const each = amount / targets.length;
      let acc = 0;
      let t = 0;
      for (let j = 0; j < glyphs.length; j++) {
        while (t < targets.length && targets[t] < j) { acc += each; t++; }
        shift[j] = acc;
      }
    };
    const between = () => { const out = []; for (let j = Math.max(firstVisible, 0) + 1; j <= lastVisible; j++) out.push(j - 1); return out; };
    if (remaining < 0 && inner.length) spread(remaining, inner); // 최소 공백으로 줄인 빈칸
    else if (remaining < 0 && avail < NO_WRAP / 2 && lastVisible > firstVisible && remaining > -avail) spread(remaining, between()); // 저장된 줄 정보보다 넘치면 글자 사이를 좁힌다
    else if (remaining > 0) {
      if (align === 'JUSTIFY' && !isLast) {
        if (inner.length) spread(remaining, inner); else if (lastVisible > firstVisible) spread(remaining, between());
      } else if (align === 'DISTRIBUTE') {
        if (lastVisible > firstVisible) spread(remaining, between());
      } else if (align === 'DISTRIBUTE_SPACE') {
        if (inner.length) spread(remaining, inner); else if (lastVisible > firstVisible) spread(remaining, between());
      } else if (align === 'RIGHT') x0 = remaining;
      else if (align === 'CENTER') x0 = remaining / 2;
    }
    for (let j = 0; j < glyphs.length; j++) glyphs[j].x = origin + x0 + glyphs[j].x + shift[j];
    if (first && lay.label) {
      const lb = lay.label;
      const look = charLook(ctx, lb.cp);
      let lx = dropped ? pp.left : pp.left + (style.headHangs ? 0 : Math.max(pp.indent, 0));
      line.labelGlyphs = Array.from(lb.text).map((ch) => {
        const adv = charAdvance(ch, lb.em / 100, look);
        const g = { ch, x: lx, adv, plain: charAdvance(ch, lb.em / 100, withoutSpacing(look)), size: lb.em, cp: lb.cp, look };
        lx += adv;
        return g;
      });
    }
    line.glyphs = glyphs;
    line.origin = origin;
    line.avail = avail;
    // 기준선: 줄 맨 위에서 글자 높이의 85%. 개체가 더 높으면 줄 바닥에 맞춘다.
    const ts = line.textSize || lay.size;
    line.baseline = line.height - ts * 0.15;
    // 짜내기(SQUEEZE): 넘치면 가로로 눌러 담는다
    if ((pp.lineWrap === 'SQUEEZE' || lay.squeezeTo) && lastVisible >= 0) {
      const room = lay.squeezeTo || (lay.width - pp.left - pp.right);
      if (natural > room && natural > 0) {
        line.squeeze = room / natural;
        for (const g of glyphs) g.x = origin + (g.x - origin) * line.squeeze;
      } else if (align === 'CENTER' || align === 'RIGHT') {
        const rem = room - natural;
        const off = align === 'CENTER' ? rem / 2 : rem;
        for (const g of glyphs) g.x = origin + (g.x - origin - x0) + off;
      }
    }
  }

  // ------------------------------------------------------------------ 표
  function cellMargins(tc, tbl) {
    const own = kid(tc, 'cellMargin');
    const inherited = kid(tbl, 'inMargin');
    const src = on(tc.getAttribute('hasMargin')) ? (own || inherited) : (inherited || own);
    if (!src) return { left: 0, right: 0, top: 0, bottom: 0 };
    return { left: num(src.getAttribute('left')), right: num(src.getAttribute('right')), top: num(src.getAttribute('top')), bottom: num(src.getAttribute('bottom')) };
  }
  function outMargins(el) {
    const m = kid(el, 'outMargin');
    const v = (s) => { const n = num(m && m.getAttribute(s)); return n < 0 || n >= 2 ** 31 ? 0 : n; };
    return m ? [v('left'), v('right'), v('top'), v('bottom')] : [0, 0, 0, 0];
  }
  function layoutTable(ctx, tbl) {
    if (tbl.__layout && tbl.__layoutWidthKey === ctx.layoutKey) return tbl.__layout;
    const spacing = (() => { const s = num(tbl.getAttribute('cellSpacing')); return s > 0 && s < 2 ** 31 ? s : 0; })();
    const cells = [];
    for (const tr of kids(tbl, 'tr')) {
      for (const tc of kids(tr, 'tc')) {
        const addr = kid(tc, 'cellAddr'), span = kid(tc, 'cellSpan'), sz = kid(tc, 'cellSz'), sub = kid(tc, 'subList');
        const declared = num(sz && sz.getAttribute('height'));
        cells.push({
          el: tc, row: num(addr && addr.getAttribute('rowAddr')), col: num(addr && addr.getAttribute('colAddr')),
          rowSpan: Math.max(1, num(span && span.getAttribute('rowSpan'), 1)), colSpan: Math.max(1, num(span && span.getAttribute('colSpan'), 1)),
          ownWidth: num(sz && sz.getAttribute('width')), declared: declared >= 2 ** 31 ? 0 : declared,
          header: on(tc.getAttribute('header')), bf: tc.getAttribute('borderFillIDRef') || tbl.getAttribute('borderFillIDRef'),
          margins: cellMargins(tc, tbl), valign: (sub && sub.getAttribute('vertAlign')) || 'TOP',
          lineWrap: (sub && sub.getAttribute('lineWrap')) || 'BREAK', paras: sub ? kids(sub, 'p').map(parseParagraph) : [],
        });
      }
    }
    // 열 시작(grid_widths_of)
    const starts = new Map([[0, 0]]);
    const ends = [...new Set(cells.map((c) => c.col + c.colSpan))].sort((a, b) => a - b);
    let gridOk = true;
    for (const end of ends) {
      const reach = cells.filter((c) => c.col + c.colSpan === end && starts.has(c.col)).map((c) => starts.get(c.col) + c.ownWidth + spacing);
      if (!reach.length) { gridOk = false; break; }
      starts.set(end, Math.max(...reach));
    }
    for (const c of cells) {
      if (gridOk && starts.has(c.col) && starts.has(c.col + c.colSpan)) {
        c.x = starts.get(c.col) + (spacing ? spacing : 0) * 0;
        c.width = starts.get(c.col + c.colSpan) - starts.get(c.col) - spacing;
      } else { c.x = 0; c.width = c.ownWidth; }
    }
    const tableWidth = gridOk ? Math.max(...[...starts.values()]) + (spacing ? spacing : 0) : Math.max(...cells.map((c) => c.ownWidth), 0);
    // 칸 내용
    for (const c of cells) {
      const inner = c.width - c.margins.left - c.margins.right;
      const squeezed = c.lineWrap === 'SQUEEZE' || c.lineWrap === 'KEEP';
      c.lays = c.paras.map((p) => {
        const l = layoutParagraph(ctx, p, squeezed ? NO_WRAP : inner, { noWrap: squeezed, inCell: true });
        if (squeezed) {
          l.width = inner;
          l.squeezeTo = inner - (l.pp.left + l.pp.right);
          for (let k = 0; k < l.lines.length; k++) buildLineGlyphs(ctx, l, k);
        }
        return l;
      });
      const before = c.lays.length ? c.lays[0].prev : 0;
      c.content = c.lays.length ? stackHeight(c.lays) + before : 0;
      c.before = before;
      c.need = c.margins.top + c.margins.bottom + c.content;
      c.height = Math.max(c.declared, c.need);
      if (spacing) c.height += spacing;
      // 줄(쪽 넘김 때 나눌 자리)
      c.lineTops = [];
      let y = before;
      let pending = null;
      for (const l of c.lays) {
        if (pending !== null) y += pending + l.prev;
        for (let k = 0; k < l.lines.length; k++) {
          c.lineTops.push({ top: y, height: l.lines[k].height });
          if (k < l.lines.length - 1) y += l.lines[k].advance;
        }
        const last = l.lines[l.lines.length - 1];
        pending = last.advance - last.height + l.next;
      }
    }
    // 행 높이(_table_rows)
    const rowSet = new Map();
    const merged = [];
    for (const c of cells) {
      if (c.rowSpan === 1) {
        const cur = rowSet.get(c.row);
        if (cur === undefined || c.height > cur) rowSet.set(c.row, c.height);
      } else merged.push(c);
    }
    for (const c of merged) for (let r = c.row; r < c.row + c.rowSpan; r++) if (!rowSet.has(r)) rowSet.set(r, 0);
    merged.sort((a, b) => (a.row + a.rowSpan) - (b.row + b.rowSpan) || a.row - b.row);
    for (const c of merged) {
      let sum = 0;
      for (let r = c.row; r < c.row + c.rowSpan; r++) sum += rowSet.get(r);
      const lacking = c.height - sum;
      const last = c.row + c.rowSpan - 1;
      rowSet.set(last, rowSet.get(last) + Math.max(lacking, 0));
    }
    const order = [...rowSet.keys()].sort((a, b) => a - b);
    const rowIndex = new Map(order.map((r, i) => [r, i]));
    const rows = order.map((r) => ({ addr: r, height: rowSet.get(r), header: false, joined: false, merged: false, cells: [] }));
    const rowTop = [];
    let acc = 0;
    for (const r of rows) { rowTop.push(acc); acc += r.height; }
    for (const c of cells) {
      const ri = rowIndex.get(c.row);
      c.ri = ri;
      c.y = rowTop[ri];
      let h = 0;
      for (let r = ri; r < ri + c.rowSpan && r < rows.length; r++) h += rows[r].height;
      c.h = h;
      rows[ri].cells.push(c);
      if (c.header && c.rowSpan === 1) rows[ri].header = true;
      if (c.rowSpan > 1) for (let r = ri; r < ri + c.rowSpan && r < rows.length; r++) { rows[r].merged = true; if (r < ri + c.rowSpan - 1) rows[r].joined = true; }
    }
    // 쪽 넘김 계산에 쓰는 행 정보
    for (const r of rows) {
      const own = r.cells.filter((c) => c.rowSpan === 1);
      let tallest = null;
      for (const c of own) if (!tallest || c.height > tallest.height || (c.height === tallest.height && c.lineTops.length > tallest.lineTops.length)) tallest = c;
      r.tallest = tallest;
      if (tallest) {
        r.lines = tallest.lineTops.length || 1;
        const lastLay = tallest.lays[tallest.lays.length - 1];
        const ll = lastLay ? lastLay.lines[lastLay.lines.length - 1] : null;
        r.size = ll ? ll.height : 1000;
        r.pitch = ll ? ll.advance : 1600;
        r.margins = tallest.margins.top + tallest.margins.bottom;
        r.spare = tallest.height - (tallest.margins.top + tallest.margins.bottom) - tallest.content;
        r.first = Math.max(...own.map((c) => c.before + (c.lineTops[0] ? c.lineTops[0].height : 0)));
        r.metrics = tallest.lays.length > 1 ? cellMetrics(tallest) : null;
        r.leads = tallest.lays.length > 1 || tallest.before ? cellLeads(tallest) : null;
      } else { r.lines = 1; r.size = r.height; r.pitch = r.height; r.margins = 0; r.spare = 0; r.first = 0; r.metrics = null; r.leads = null; }
    }
    const out = outMargins(tbl);
    const layout = {
      el: tbl, cells, rows, rowTop, width: tableWidth, height: acc + spacing, out, spacing,
      mode: tbl.getAttribute('pageBreak') || 'CELL', repeatHeader: on(tbl.getAttribute('repeatHeader')), noAdjust: on(tbl.getAttribute('noAdjust')),
      bf: tbl.getAttribute('borderFillIDRef'),
    };
    tbl.__layout = layout;
    tbl.__layoutWidthKey = ctx.layoutKey;
    return layout;
  }
  /** 칸 안 줄마다 (높이, 다음 줄까지). 문단 사이 간격은 앞 문단 마지막 줄에 더한다(stack_lines). */
  function cellMetrics(c) {
    const m = [];
    for (const l of c.lays) {
      if (m.length) m[m.length - 1][1] += l.prev;
      l.lines.forEach((ln, k) => m.push([ln.height, ln.advance + (k === l.lines.length - 1 ? l.next : 0)]));
    }
    return m;
  }
  function cellLeads(c) {
    const leads = [];
    for (let p = 0; p < c.lays.length; p++) for (let k = 0; k < c.lays[p].lines.length; k++) leads.push(k === 0 ? c.lays[p].prev : 0);
    return leads;
  }
  function flowTableOf(ctx, obj) {
    const tl = layoutTable(ctx, obj.el);
    const pos = obj.pos;
    const offset = pos ? signed32(num(pos.getAttribute('vertOffset'))) : 0;
    return { layout: tl, mode: tl.mode, repeatHeader: tl.repeatHeader, margins: [tl.out[2], tl.out[3] + tl.spacing], offset: offset < 0 ? 0 : offset, cut: tl.noAdjust ? SPARE_CUT_FIXED : SPARE_CUT, obj };
  }
  function objectExtent(ctx, el, name) {
    const out = outMargins(el);
    if (name === 'tbl') {
      const tl = layoutTable(ctx, el);
      return { width: tl.width + out[0] + out[1], height: tl.height + out[2] + out[3], layout: tl, out };
    }
    const sz = kid(el, 'sz');
    let w = num(sz && sz.getAttribute('width')), h = num(sz && sz.getAttribute('height'));
    const cur = kid(el, 'curSz');
    if ((!w || !h) && cur) { w = num(cur.getAttribute('width')); h = num(cur.getAttribute('height')); }
    return { width: w + out[0] + out[1], height: h + out[2] + out[3], layout: null, out, w, h };
  }

  // ------------------------------------------------------------------ 구역(쪽) 설정
  function sectionSettings(secPr) {
    const pagePr = kid(secPr, 'pagePr');
    const margin = kid(pagePr, 'margin');
    let width = num(pagePr && pagePr.getAttribute('width'), 59528), height = num(pagePr && pagePr.getAttribute('height'), 84188);
    const landscape = pagePr ? pagePr.getAttribute('landscape') : 'WIDELY';
    if (landscape && landscape !== 'WIDELY') [width, height] = [height, width];
    const m = (k, d) => {
      const raw = margin ? margin.getAttribute(k) : null;
      if (raw === null) return d;
      if (String(raw).trim().startsWith('-')) return { top: 5668, bottom: 4252, left: 8504, right: 8504, header: 4252, footer: 4252, gutter: 0 }[k];
      return signed32(num(raw, d));
    };
    const margins = { left: m('left', 8504), right: m('right', 8504), top: m('top', 5668), bottom: m('bottom', 4252), header: m('header', 4252), footer: m('footer', 4252), gutter: m('gutter', 0) };
    const body = height - margins.top - margins.bottom - margins.header - margins.footer;
    const textWidth = width - margins.left - margins.right - margins.gutter;
    const noteOf = (name) => {
      const el = kid(secPr, name);
      if (!el) return { above: 0, line: 0, below: 0, between: 0, lineLength: -1, lineColor: '#000000', lineType: 'SOLID', type: 'DIGIT', prefix: '', suffix: ')' };
      const sp = kid(el, 'noteSpacing'), ln = kid(el, 'noteLine'), fmt = kid(el, 'autoNumFormat');
      return {
        above: num(sp && sp.getAttribute('aboveLine')), below: num(sp && sp.getAttribute('belowLine')), between: num(sp && sp.getAttribute('betweenNotes')),
        line: Math.round(parseFloat(((ln && ln.getAttribute('width')) || '0 mm').split(' ')[0]) * 7200 / 25.4) || 0,
        lineLength: ln ? signed32(num(ln.getAttribute('length'), -1)) : -1, lineColor: colorOf(ln && ln.getAttribute('color'), '#000000'),
        lineType: (ln && ln.getAttribute('type')) || 'SOLID',
        type: (fmt && fmt.getAttribute('type')) || 'DIGIT', prefix: (fmt && fmt.getAttribute('prefixChar')) || '', suffix: (fmt && fmt.getAttribute('suffixChar')) || ')',
        sup: fmt ? on(fmt.getAttribute('supscript')) : false,
      };
    };
    const cols = (() => {
      for (const c of descendants(secPr.parentNode, 'colPr')) return c;
      return null;
    })();
    const tabStopVal = secPr.getAttribute('tabStopVal');
    const tabStop = tabStopVal === null ? DEFAULT_TAB_STOP : ((secPr.getAttribute('tabStopUnit') || 'HWPUNIT') !== 'HWPUNIT' || !+tabStopVal ? DEFAULT_TAB_STOP : +tabStopVal);
    const startNum = kid(secPr, 'startNum');
    const visibility = kid(secPr, 'visibility');
    return {
      width, height, margins, body, textWidth, footNote: noteOf('footNotePr'), endNote: noteOf('endNotePr'),
      tabStop, outlineRef: secPr.getAttribute('outlineShapeIDRef') || '1',
      startPage: num(startNum && startNum.getAttribute('page'), 0), pageStartsOn: startNum ? startNum.getAttribute('pageStartsOn') : 'BOTH',
      hideFirstPageNum: visibility ? on(visibility.getAttribute('hideFirstPageNum')) : false,
      colPr: cols,
    };
  }
  function columnLayout(colPr, textWidth) {
    const count = colPr ? num(colPr.getAttribute('colCount'), 1) : 1;
    if (count <= 1) return { count: 1, width: textWidth, gap: 0, widths: null };
    if (!on(colPr.getAttribute('sameSz'))) {
      const sizes = kids(colPr, 'colSz');
      const total = sizes.reduce((a, s) => a + num(s.getAttribute('width')) + num(s.getAttribute('gap')), 0);
      if (sizes.length === count && total > 0) {
        const widths = sizes.map((s) => Math.floor((2 * num(s.getAttribute('width')) * textWidth + 32768) / (2 * 32768)));
        const gaps = sizes.map((s) => Math.floor((2 * num(s.getAttribute('gap')) * textWidth + 32768) / (2 * 32768)));
        return { count, width: Math.min(...widths), gap: 0, widths, gaps };
      }
    }
    let gap = num(colPr.getAttribute('sameGap'));
    if (gap >= 2 ** 31) gap -= 2 ** 32;
    return { count, width: Math.floor(Math.floor((textWidth - (count - 1) * gap) / count) / 4) * 4, gap, widths: null };
  }

  // ------------------------------------------------------------------ 쪽 나눔(_Paginator 일부)
  function noteArea(shape, height, count) {
    return count === 0 ? 0 : shape.above + shape.line + shape.below + height + shape.between * (count - 1);
  }
  function lineH(p, k) { return p.lines[k].height; }
  function lineAdv(p, k) { return p.lines[k].advance; }
  function spanOf(p, first, count) { let s = 0; for (let k = first; k < first + count; k++) s += p.lines[k].advance; return s; }

  class Paginator {
    constructor(body, columns, notes) {
      this.body = body; this.columns = columns; this.notes = notes;
      this.out = []; this.counts = []; this.frame = 0; this.lastVp = null; this.lastPitch = 0; this.pendingNext = 0;
      this.pageNotes = [0, 0]; this.carry = 0; this.floor = null; this.under = null; this.tableEnd = 0;
      this.flows = []; // 흐르는 표 배치
      this.noteLines = []; // [frame, para, line]
    }
    run(paras) {
      paras.forEach((para, index) => {
        const first = this.out.length;
        this.paragraph(index, paras, para);
        this.counts.push(this.out.length - first);
      });
      return Math.max(this.out.length ? this.out[this.out.length - 1][0] : 0, this.tableEnd) + 1;
    }
    paragraph(index, paras, para) {
      let start = this.lastVp === null ? para.prev : this.lastVp + this.lastPitch + this.pendingNext + para.prev;
      if (this.under !== null) { start = this.under; this.under = null; }
      if (this.floor !== null) { start = Math.max(start, this.floor); this.floor = null; }
      let broke;
      [start, broke] = this.breaks(para, start);
      if (para.flowTable) { this.flow(index, para, para.flowTable, start); return; }
      if (this.lay(index, paras, para, start, broke)) {
        this.lastVp = this.out[this.out.length - 1][1];
        this.lastPitch = lineAdv(para, para.lines.length - 1);
        this.pendingNext = para.next;
      }
    }
    breaks(para, start) {
      if (this.lastVp === null) return [start, false];
      if (para.pageBreak || para.breakBefore) this.frame = (Math.floor(this.frame / this.columns) + 1) * this.columns;
      else if (para.columnBreak) this.frame += 1;
      else return [start, false];
      this.pageNotes = [0, 0];
      return [para.prev, true];
    }
    flow(index, para, table, start) {
      if (this.lastVp !== null && start + lineH(para, 0) > this.body) start = this.nextFrame(para, 0, true);
      this.out.push([this.frame, start]);
      const before = this.frame;
      const top = start - para.prev + table.offset + table.margins[0];
      const placement = flowTable(table, this.frame, top, this.body);
      this.flows.push({ index, table, placement, anchorFrame: before });
      let frame = placement.frame, end = placement.end;
      const later = start + lineH(para, 0) <= this.body && startsLater(table, top, this.body);
      if (later) {
        // 첫 행이 들어가지 않는 표는 다음 쪽 맨 위에서 시작하고, 글은 기준 줄 아래로 이어진다
        const next = flowTable(table, this.frame + 1, repeatedHeader(table) + table.margins[0], this.body);
        this.flows[this.flows.length - 1].placement = next;
        frame = next.frame; end = next.end;
      }
      this.tableEnd = Math.max(this.tableEnd, frame);
      this.frame = frame;
      if (this.frame !== before) {
        this.pageNotes = [0, 0];
        this.lastVp = end + table.margins[1]; this.lastPitch = 0; this.pendingNext = para.next;
        this.under = end + table.margins[1];
      } else {
        this.lastVp = start; this.lastPitch = lineAdv(para, 0); this.pendingNext = para.next;
        this.floor = end + table.margins[1];
      }
    }
    lay(index, paras, para, start, broke) {
      let remaining = para.lines.length, firstChunk = true;
      let fresh = this.lastVp === null || broke;
      while (remaining) {
        const done = para.lines.length - remaining;
        let count = this.chunk(index, paras, para, start, remaining, done, firstChunk);
        if (count === 0 && (this.lastVp === null || fresh)) count = 1;
        for (let j = 0; j < count; j++) this.out.push([this.frame, start + spanOf(para, done, j)]);
        this.place(para, done, count);
        remaining -= count;
        if (!remaining && this.carry) {
          this.frame += 1;
          this.pageNotes = [this.carry, 1];
          this.lastVp = null; this.lastPitch = 0; this.pendingNext = 0;
          return false;
        }
        if (remaining) start = this.nextFrame(para, count, firstChunk);
        fresh = !!remaining;
        firstChunk = false;
      }
      return true;
    }
    nextFrame(para, count, firstChunk) {
      this.frame += 1;
      this.pageNotes = this.carry ? [this.carry, 1] : [0, 0];
      return count === 0 && firstChunk ? para.prev : 0;
    }
    chunk(index, paras, para, start, remaining, done, firstChunk) {
      let count = this.fits(start, remaining, para, done);
      if (!firstChunk) return count;
      if (count < remaining) count = this.keepRules(para, start, remaining, count);
      if (count === remaining && para.keepNext && index + 1 < paras.length) count = this.keepWithNext(para, paras.slice(index + 1), start, remaining, count);
      return count;
    }
    keepRules(para, start, remaining, count) {
      if (para.keepLines && this.fits(para.prev, para.lines.length, para) === para.lines.length && start !== para.prev) return 0;
      if (para.widowOrphan) {
        if (count === 1 && remaining > 1) return 0;
        if (remaining - count === 1 && count > 1) return count - 1;
      }
      return count;
    }
    keepWithNext(para, following, start, remaining, count) {
      if (start === para.prev) return count;
      const saved = this.pageNotes.slice(), carry = this.carry;
      try { return this.chainStays(para, following, start, remaining, count); } finally { this.pageNotes = saved; this.carry = carry; }
    }
    chainStays(para, following, start, remaining, count) {
      for (let line = 0; line < remaining; line++) {
        const n = para.notes.get(line);
        if (n) this.pageNotes = [this.pageNotes[0] + n.height, this.pageNotes[1] + n.count];
      }
      let after = start + spanOf(para, 0, remaining) + para.next;
      for (let i = 0; i < following.length; i++) {
        const item = following[i];
        after += item.prev;
        if (!item.keepNext || item.flowTable || item.pageBreak || item.breakBefore || i === following.length - 1) {
          const need = item.widowOrphan && item.lines.length > 1 ? 2 : 1;
          return this.fits(after, need, item) >= need ? count : 0;
        }
        const fit = this.fits(after, item.lines.length, item);
        if (fit === item.lines.length) {
          after += spanOf(item, 0, item.lines.length) + item.next;
          for (const n of item.notes.values()) this.pageNotes = [this.pageNotes[0] + n.height, this.pageNotes[1] + n.count];
          continue;
        }
        return fit && !item.keepLines ? count : 0;
      }
      return count;
    }
    fits(start, count, para, first = 0) {
      let fitting = 0, height = this.pageNotes[0], many = this.pageNotes[1];
      this.carry = 0;
      while (fitting < count) {
        const n = para.notes.get(first + fitting) || { height: 0, count: 0, first: 0 };
        const bottom = start + spanOf(para, first, fitting) + lineH(para, first + fitting);
        if (bottom < this.body - noteArea(this.notes, height + n.height, many + n.count)) {
          height += n.height; many += n.count; fitting += 1;
          continue;
        }
        if (n.count && bottom < this.body - noteArea(this.notes, height + n.first, many + n.count)) {
          const room = this.body - bottom - noteArea(this.notes, height, many + n.count) + n.height;
          this.carry = Math.max(n.height - room, 0);
          fitting += 1;
        }
        break;
      }
      return fitting;
    }
    place(para, first, count) {
      const placed = this.out.slice(this.out.length - count);
      for (let k = 0; k < count; k++) {
        const n = para.notes.get(first + k);
        if (n) {
          this.pageNotes[0] += n.height; this.pageNotes[1] += n.count;
          this.noteLines.push({ frame: placed[k][0], note: n });
        }
      }
    }
  }
  function repeatedHeader(table) {
    if (!table.repeatHeader) return 0;
    return table.layout.rows.filter((r) => r.header).reduce((a, r) => a + r.height, 0);
  }
  function headerMoves(table, y, body) {
    const header = repeatedHeader(table);
    return (table.mode === 'TABLE' || table.mode === 'CELL') && !!header && y + header > body - table.cut && y > table.margins[0];
  }
  function startsLater(table, y, body) {
    const rows = table.layout.rows;
    if (!['TABLE', 'NONE', 'CELL'].includes(table.mode) || !rows.length) return false;
    if (headerMoves(table, y, body - table.margins[1])) return true;
    if (table.mode === 'CELL') return false;
    const first = table.mode === 'NONE' ? rows.reduce((a, r) => a + r.height, 0) : rows[0].height;
    return y + first > body - table.margins[1] - table.cut && y !== repeatedHeader(table) + table.margins[0];
  }
  function linesFitting(lines, leads, top, foot) {
    let fitting = 0, y = top + (leads && leads.length ? leads[0] : 0);
    while (fitting < lines.length && y + lines[fitting][0] <= foot) { y += lines[fitting][1]; fitting++; }
    return fitting;
  }
  function linesHeight(lines, leads) {
    let h = leads && leads.length ? leads[0] : 0;
    for (let k = 0; k < lines.length - 1; k++) h += lines[k][1];
    return h + lines[lines.length - 1][0];
  }
  /** 흐르는 표의 행을 쪽에 나누어 놓는다(_flow_table). 쪽마다 그릴 조각을 함께 돌려준다.
   *  조각의 parts: {row, height(이 쪽에서 차지하는 높이), shift(칸 내용을 위로 올릴 양), cut} */
  function flowTable(table, frame, y, body) {
    body -= table.margins[1];
    const header = repeatedHeader(table) + table.margins[0];
    const foot = body - table.cut;
    const rows = table.layout.rows;
    const segs = [];
    const headerRows = table.repeatHeader ? rows.map((r, i) => (r.header ? i : -1)).filter((i) => i >= 0) : [];
    let seg = null;
    const open = (f, top) => {
      seg = { frame: f, top, parts: [], repeat: segs.length > 0 ? headerRows.slice() : [] };
      segs.push(seg);
    };
    if (headerMoves(table, y, body)) { frame += 1; y = table.margins[0]; }
    if (table.mode === 'NONE') {
      const height = rows.reduce((a, r) => a + r.height, 0);
      if (y + height > foot && y !== header) { frame += 1; y = header; }
      open(frame, y);
      seg.repeat = [];
      rows.forEach((r, i) => seg.parts.push({ row: i, height: r.height, shift: 0 }));
      return { frame, end: y + height, segs };
    }
    open(frame, y);
    let index = 0;
    while (index < rows.length) {
      let end = index;
      while (rows[end].joined && end + 1 < rows.length) end++;
      if (end > index) { // 합친 칸으로 묶인 행들은 함께 옮긴다(나누지 않음)
        const height = rows.slice(index, end + 1).reduce((a, r) => a + r.height, 0);
        if (y + height > foot && y !== header) { frame += 1; y = header; open(frame, y); }
        for (let r = index; r <= end; r++) seg.parts.push({ row: r, height: rows[r].height, shift: 0 });
        y += height;
        index = end + 1;
        continue;
      }
      const row = rows[index];
      const tops = row.tallest ? row.tallest.lineTops : [];
      let remaining = row.lines, height = row.height, metrics = row.metrics, leads = row.leads, shift = 0, used = 0;
      for (; ;) {
        if (y + height <= foot) { seg.parts.push({ row: index, height, shift }); y += height; break; }
        const fresh = y === header;
        if (table.mode === 'CELL') {
          const lines = metrics || Array.from({ length: remaining }, () => [row.size, row.pitch]);
          let fitting = linesFitting(lines, leads, y + row.margins, foot);
          if (fitting && lines.length === row.lines && y + row.margins + row.first > foot) fitting = 0;
          if (fitting && (row.spare || fitting === lines.length)) { // 선언 높이가 남는 행: 쪽 끝에서 자른다
            let rest = height - (foot - y);
            if (fitting < lines.length && y + height - row.spare > foot) rest = Math.max(rest, row.margins + linesHeight(lines.slice(fitting), leads ? leads.slice(fitting) : null));
            else if (rest <= SPARE_DROPPED) { seg.parts.push({ row: index, height: foot - y, shift }); y = body; break; }
            seg.parts.push({ row: index, height: foot - y, shift, cut: true });
            shift += foot - y;
            frame += 1; y = header; open(frame, y);
            remaining = 1; height = rest; metrics = null; leads = null;
            continue;
          }
          if (fitting) { // 줄 사이에서 나눈다: 들어가는 줄까지만 보이고 나머지 줄은 다음 쪽으로
            seg.parts.push({ row: index, height: foot - y, shift, cut: true, keep: linesHeight(lines.slice(0, fitting), leads ? leads.slice(0, fitting) : null) });
            used += fitting;
            shift = tops[used] ? tops[used].top : shift + (foot - y);
            metrics = lines.slice(fitting); leads = leads ? leads.slice(fitting) : null;
            remaining = metrics.length; height = row.margins + linesHeight(metrics, leads);
          } else if (fresh) { seg.parts.push({ row: index, height, shift }); y += height; break; }
        } else if (fresh) { seg.parts.push({ row: index, height, shift }); y += height; break; }
        frame += 1; y = header; open(frame, y);
      }
      index += 1;
    }
    return { frame, end: y, segs: segs.filter((s) => s.parts.length) };
  }

  // ------------------------------------------------------------------ 문서 전체 배치
  function layoutDocument(pkg) {
    const H = parseHeader(pkg.header, pkg.version);
    const doc = { H, pages: [], outline: [], warnings: new Set(), fonts: new Map(), bins: pkg.bins };
    let pageNumber = H.beginNum.page;
    let footCounter = 0;
    const endnotes = [];
    let lastSection = null;
    for (let s = 0; s < pkg.sections.length; s++) {
      const secEl = pkg.sections[s];
      const paraEls = kids(secEl, 'p');
      const paras = paraEls.map(parseParagraph);
      let secPr = null;
      for (const p of paras) { for (const r of p.runs) for (const it of r.items) if (it.kind === 'secPr') { secPr = it.el; break; } if (secPr) break; }
      const S = secPr ? sectionSettings(secPr) : sectionSettings(document.createElementNS('http://www.hancom.co.kr/hwpml/2011/paragraph', 'secPr'));
      const cols = columnLayout(S.colPr, S.textWidth);
      const ctx = {
        H, looks: new Map(), lookBySig: new Map(), paraStyles: new Map(), tabStop: S.tabStop, columnWidth: cols.width,
        section: S, noteCounter: { footNote: footCounter, endNote: 0 }, counters: {}, outlineRef: S.outlineRef, layoutKey: 's' + s,
      };
      const lays = paras.map((p) => {
        try { return layoutParagraph(ctx, p, cols.width); } catch (err) {
          doc.warnings.add('일부 문단을 그리지 못해 빈 줄로 두었습니다');
          if (global.console) console.warn('문단 배치 실패', err);
          return fallbackLayout(p);
        }
      });
      footCounter = ctx.noteCounter.footNote;
      for (const l of lays) collectWarnings(doc, l);
      const pg = new Paginator(S.body, cols.count, S.footNote);
      const frames = pg.run(lays);
      const pageCount = Math.ceil(frames / cols.count);
      const firstPage = doc.pages.length;
      if (S.startPage > 0) pageNumber = S.startPage;
      const pages = [];
      for (let i = 0; i < pageCount; i++) pages.push({ section: S, cols, items: [], notes: [], flows: [], number: 0, hideNumber: false, newNum: null, headerParas: null, footerParas: null, pageNum: null });
      // 줄 놓기
      let li = 0;
      lays.forEach((lay, pi) => {
        const count = pg.counts[pi];
        for (let k = 0; k < count; k++) {
          const [frame, y] = pg.out[li++];
          const page = pages[Math.floor(frame / cols.count)];
          if (!page) continue;
          page.items.push({ lay, line: k, frame, col: frame % cols.count, y });
        }
      });
      for (const f of pg.flows) {
        for (const seg of f.placement.segs) {
          const page = pages[Math.floor(seg.frame / cols.count)];
          if (page) page.flows.push({ table: f.table, seg, col: seg.frame % cols.count });
        }
      }
      for (const nl of pg.noteLines) {
        const page = pages[Math.floor(nl.frame / cols.count)];
        if (page) page.notes.push(...nl.note.items);
      }
      // 쪽 번호·감추기·새 번호
      let pageNumCtrl = null;
      const headers = [], footers = [];
      lays.forEach((lay) => {
        const item = pages.findIndex((pgx) => pgx.items.some((it) => it.lay === lay));
        for (const c of lay.content.ctrls) {
          if (c.name === 'pageNum') pageNumCtrl = pageNumCtrl || { pos: c.el.getAttribute('pos') || 'BOTTOM_CENTER', format: c.el.getAttribute('formatType') || 'DIGIT', side: c.el.getAttribute('sideChar') || '', cp: c.cp, from: Math.max(item, 0) };
          else if (c.name === 'pageHiding' && item >= 0) pages[item].hiding = { pageNum: on(c.el.getAttribute('hidePageNum')), header: on(c.el.getAttribute('hideHeader')), footer: on(c.el.getAttribute('hideFooter')) };
          else if (c.name === 'newNum' && item >= 0 && (c.el.getAttribute('numType') || 'PAGE') === 'PAGE') pages[item].newNum = num(c.el.getAttribute('num'), 1);
          else if (c.name === 'header' || c.name === 'footer') {
            const sub = kid(c.el, 'subList');
            const entry = { apply: c.el.getAttribute('applyPageType') || 'BOTH', paras: sub ? kids(sub, 'p').map(parseParagraph) : [], from: Math.max(item, 0) };
            (c.name === 'header' ? headers : footers).push(entry);
          }
        }
      });
      pages.forEach((page, i) => {
        if (page.newNum !== null) pageNumber = page.newNum;
        page.number = pageNumber;
        pageNumber += 1;
        page.pageNum = pageNumCtrl && i >= pageNumCtrl.from ? pageNumCtrl : null;
        if (page.hiding && page.hiding.pageNum) page.pageNum = null;
        if (i === 0 && S.hideFirstPageNum) page.pageNum = null;
        const pick = (list) => {
          let found = null;
          for (const e of list) if (e.from <= i && (e.apply === 'BOTH' || (e.apply === 'ODD') === ((page.number % 2) === 1))) found = e;
          return found;
        };
        const hd = pick(headers), ft = pick(footers);
        if (hd && !(page.hiding && page.hiding.header)) page.header = hd.paras.map((p) => layoutParagraph(ctx, p, S.textWidth, { noNotes: true }));
        if (ft && !(page.hiding && page.hiding.footer)) page.footer = ft.paras.map((p) => layoutParagraph(ctx, p, S.textWidth, { noNotes: true }));
        page.index = firstPage + i;
        doc.pages.push(page);
      });
      // 목차(제목처럼 보이는 문단)
      for (const page of pages) {
        for (const it of page.items) {
          if (it.line !== 0) continue;
          const h = headingOf(it.lay);
          if (h) doc.outline.push({ text: h.text, level: h.level, page: page.index, y: it.y });
        }
      }
      for (const [, look] of ctx.looks) noteFont(doc, look);
      (doc.debug = doc.debug || []).push({ secEl, lays, pg });
      for (const l of lays) if (l.endnotes) endnotes.push(...l.endnotes);
      lastSection = { S, cols, pages, pg, lays, firstPage };
    }
    if (endnotes.length && lastSection) placeEndnotes(doc, lastSection, endnotes);
    return doc;
  }
  /** 미주: 문서 끝 마지막 줄 아래에 구분선과 함께 잇는다(_with_endnotes). */
  function placeEndnotes(doc, sec, notes) {
    const { S, cols, pages, pg } = sec;
    const shape = S.endNote;
    if (!pg.out.length) return;
    const [lastFrame, lastY] = pg.out[pg.out.length - 1];
    let lastLay = null, lastLine = 0;
    for (const page of pages) for (const it of page.items) { lastLay = it.lay; lastLine = it.line; }
    let frame = lastFrame;
    let top = lastY + (lastLay ? lastLay.lines[lastLine].height : 0);
    if (pages[Math.floor(frame / cols.count)] && pages[Math.floor(frame / cols.count)].notes.length) { frame += 1; top = 0; }
    const ensure = (f) => {
      const idx = Math.floor(f / cols.count);
      while (pages.length <= idx) {
        const np = { section: S, cols, items: [], notes: [], flows: [], number: 0, hideNumber: false, newNum: null, pageNum: pages[pages.length - 1].pageNum, header: pages[pages.length - 1].header, footer: pages[pages.length - 1].footer };
        np.number = pages[pages.length - 1].number + 1;
        np.index = doc.pages.length;
        pages.push(np);
        doc.pages.push(np);
      }
      return pages[idx];
    };
    ensure(frame).endSep = { y: top + shape.above, col: frame % cols.count };
    top += shape.above + shape.line + shape.below;
    notes.forEach((note, i) => {
      if (i) top += shape.between;
      const metrics = [];
      note.lays.forEach((l) => {
        if (metrics.length) metrics[metrics.length - 1].adv += l.prev;
        l.lines.forEach((ln, k) => metrics.push({ lay: l, line: k, h: ln.height, adv: ln.advance + (k === l.lines.length - 1 ? l.next : 0) }));
      });
      metrics.forEach((m, k) => {
        if (top + m.h > S.body && top > 0) { frame += 1; top = 0; }
        const page = ensure(frame);
        (page.endItems = page.endItems || []).push({ lay: m.lay, line: m.line, y: top, col: frame % cols.count });
        top += k === metrics.length - 1 ? m.h : m.adv;
      });
    });
  }
  function noteFont(doc, look) {
    for (const f of [look.hangulFace, look.latinFace]) if (f) doc.fonts.set(f, (doc.fonts.get(f) || 0) + 1);
  }
  function collectWarnings(doc, lay) {
    const visit = (l) => {
      for (const o of [...l.content.objects.values(), ...l.content.placed]) {
        if (['equation', 'chart', 'ole', 'video', 'textart'].includes(o.name)) doc.warnings.add('수식·차트·OLE 개체는 자리만 표시합니다');
        if (['rect', 'ellipse', 'line', 'arc', 'polygon', 'curve', 'connectLine', 'container'].includes(o.name)) doc.warnings.add('그리기 개체는 단순한 모양으로 표시합니다');
        if (o.name === 'tbl' && o.layout) for (const c of o.layout.cells) c.lays.forEach(visit);
      }
      if (l.floating.length) doc.warnings.add('글 앞·뒤에 놓인 개체는 위치가 조금 다를 수 있습니다');
      if (l.anchored && l.anchored.name !== 'tbl') doc.warnings.add('글과 따로 놓인 그림은 위치가 조금 다를 수 있습니다');
    };
    visit(lay);
  }
  function headingOf(lay) {
    const t = lay.content.text.join('').replace(/[￼\n]/g, '').trim();
    const pp = lay.pp;
    if (lay.content.objects.size === 1 && !t) {
      const o = lay.content.objects.values().next().value;
      if (o.name === 'tbl' && o.layout && o.layout.cells.length === 1) {
        const ct = o.layout.cells[0].lays.map((l) => l.content.text.join('')).join(' ').trim();
        if (/^([IVX]+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\s*\.\s*\S/.test(ct) && ct.length < 40) return { text: ct.replace(/\s+/g, ' '), level: 0 };
      }
      return null;
    }
    if (!t || t.length > 60) return null;
    const first = Array.from(t)[0];
    const cp = first.codePointAt(0);
    if (cp >= 0xf02b1 && cp <= 0xf02bf) return { text: (cp - 0xf02b0) + '. ' + Array.from(t).slice(1).join('').trim(), level: 1 };
    if (/^[□■]/.test(t)) return { text: t.replace(/^[□■]\s*/, ''), level: 1 };
    if (/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|(X|IX|VIII|VII|VI|V|IV|III|II|I)\.)\s*/.test(t) && lay.size >= 1500) return { text: t, level: 0 };
    if (pp.heading && pp.heading.type === 'OUTLINE' && pp.heading.level <= 1) return { text: t, level: pp.heading.level };
    return null;
  }

  // ------------------------------------------------------------------ 글꼴 대체
  // 페이지가 window.HWPX_FONTS로 글꼴 묶음을 바꿀 수 있다(설치형 앱은 기기에 담아 둔 글꼴 이름을 쓴다).
  const FONT_STACKS = Object.assign({
    serif: "'Nanum Myeongjo', 'Noto Serif KR', 'AppleMyungjo', 'Batang', serif",
    gothic: "'Nanum Gothic', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
    sans: "'Noto Sans KR', 'Nanum Gothic', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
  }, global.HWPX_FONTS || {});
  const SERIF = FONT_STACKS.serif;
  const NANUM_GOTHIC = FONT_STACKS.gothic;
  const NOTO_SANS = FONT_STACKS.sans;
  /** 한컴 글꼴 이름 → [CSS 글꼴, 보통 굵기, 굵게, 이름] */
  function fontFor(face) {
    const f = face || '';
    if (/헤드라인|견고딕|태백|그래픽|HY견|Black|굵은/.test(f)) return [NOTO_SANS, 800, 900, 'Noto Sans KR ExtraBold'];
    if (/나눔고딕/.test(f)) return [NANUM_GOTHIC, 400, 700, 'Nanum Gothic'];
    if (/맑은|Malgun|Pretendard|노토|Noto Sans|Segoe|Arial|Helvetica|Calibri|Tahoma|Verdana|윤고딕|KoPub돋움|산뜻|Gothic Neo/i.test(f)) return [NOTO_SANS, 400, 700, 'Noto Sans KR'];
    if (/중고딕|돋움|굴림|고딕|Dotum|Gulim|휴먼고딕|Sans/i.test(f)) return [NOTO_SANS, 500, 700, 'Noto Sans KR Medium'];
    if (/Courier|Consolas|Mono|바탕체|궁서체/i.test(f)) return ["'Nanum Gothic Coding', 'Courier New', monospace", 400, 700, 'monospace'];
    return [SERIF, 400, 700, 'Nanum Myeongjo'];
  }

  // ------------------------------------------------------------------ 그리기(SVG)
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = (v) => Math.round(v * 10) / 10;
  /** 한글 사용자 영역(PUA) 기호를 그릴 수 있는 글자나 도형으로 바꾼다. */
  const WINGDINGS = { 0x6c: '●', 0x6d: '❍', 0x6e: '■', 0x6f: '□', 0x70: '◻', 0x71: '❑', 0x72: '❒', 0x73: '⬧', 0x74: '⧫', 0x75: '◆', 0x76: '❖', 0x77: '⬥', 0x78: '⌧', 0x9f: '•', 0xa1: '○', 0xa4: '◉', 0xa7: '▪', 0xa8: '◻', 0xab: '★', 0xd8: '➢', 0xe0: '➔', 0xe8: '➔', 0xf0: '⇨', 0xfc: '✓', 0xfe: '☑', 0x46: '☞', 0x4a: '☺', 0x4c: '☹', 0x9e: '·', 0xa2: '◯', 0xa3: '◯', 0xa5: '◎', 0xae: '✶', 0xb2: '✧' };
  function symbolOf(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xf02b1 && cp <= 0xf02bf) return { box: String(cp - 0xf02b0) };
    if (cp >= 0xf02ce && cp <= 0xf02d7) return { boxFilled: String(cp - 0xf02cd) };
    if (cp === 0xf076) return { shape: 'wd-v' };
    if (cp >= 0xf020 && cp <= 0xf0ff) return { char: WINGDINGS[cp - 0xf000] || '•' };
    if (cp >= 0xe000 && cp <= 0xf8ff) return { char: '□' };
    if (cp >= 0xf0000) return { char: '□' };
    return null;
  }

  function borderDash(type, w) {
    switch (type) {
      case 'DASH': return `${r1(w * 6)} ${r1(w * 4)}`;
      case 'LONG_DASH': return `${r1(w * 12)} ${r1(w * 5)}`;
      case 'DOT': case 'CIRCLE': return `${r1(w)} ${r1(w * 2)}`;
      case 'DASH_DOT': return `${r1(w * 6)} ${r1(w * 2.5)} ${r1(w)} ${r1(w * 2.5)}`;
      case 'DASH_DOT_DOT': return `${r1(w * 6)} ${r1(w * 2)} ${r1(w)} ${r1(w * 2)} ${r1(w)} ${r1(w * 2)}`;
      default: return null;
    }
  }
  function lineSvg(x1, y1, x2, y2, side) {
    if (!side || side.type === 'NONE') return '';
    const w = Math.max(side.width, 20);
    const dash = borderDash(side.type, w);
    if (side.type === 'DOUBLE_SLIM' || side.type === 'SLIM_THICK' || side.type === 'THICK_SLIM' || side.type === 'SLIM_THICK_SLIM') {
      const horiz = y1 === y2;
      const off = w / 2;
      const a = horiz ? [x1, y1 - off, x2, y2 - off] : [x1 - off, y1, x2 - off, y2];
      const b = horiz ? [x1, y1 + off, x2, y2 + off] : [x1 + off, y1, x2 + off, y2];
      return `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(a[2])}" y2="${r1(a[3])}" stroke="${side.color}" stroke-width="${r1(w / 3)}"/>` +
        `<line x1="${r1(b[0])}" y1="${r1(b[1])}" x2="${r1(b[2])}" y2="${r1(b[3])}" stroke="${side.color}" stroke-width="${r1(w / 3)}"/>`;
    }
    return `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${side.color}" stroke-width="${r1(w)}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="butt"/>`;
  }
  function fillSvg(fill, x, y, w, h, out, defs) {
    if (!fill) return;
    if (fill.gradient && fill.gradient.length > 1) {
      const id = 'g' + (defs.n = (defs.n || 0) + 1);
      const ang = fill.angle || 0;
      const rad = ang * Math.PI / 180;
      const x2 = r1(50 + 50 * Math.cos(rad)), y2 = r1(50 + 50 * Math.sin(rad));
      defs.list.push(`<linearGradient id="${id}" x1="${r1(100 - x2)}%" y1="${r1(100 - y2)}%" x2="${x2}%" y2="${y2}%">` +
        fill.gradient.map((c, i) => `<stop offset="${r1(i * 100 / (fill.gradient.length - 1))}%" stop-color="${c}"/>`).join('') + '</linearGradient>');
      out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="url(#${id})"/>`);
      return;
    }
    out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill.color}"${fill.alpha < 1 ? ` fill-opacity="${r1(fill.alpha)}"` : ''}/>`);
  }

  /** 줄 하나를 그린다. (ox, oy)는 줄을 담은 상자의 왼쪽 위(줄 맨 위). */
  function drawLine(doc, lay, k, ox, oy, out, defs, env) {
    const line = lay.lines[k];
    if (!line) return;
    const glyphs = line.glyphs || [];
    const base = oy + line.baseline;
    // 문단 머리(글머리표·번호)
    if (line.labelGlyphs && line.labelGlyphs.length) {
      const lb = lay.label;
      const cp = doc.H.charPr.get(String(lb.cp));
      const run = [];
      for (const g of line.labelGlyphs) {
        const sym = symbolOf(g.ch);
        if (sym) out.push(symbolSvg(doc, Object.assign({}, g, { x: g.x }), sym, ox, base));
        else run.push(Object.assign({}, g, { x: ox + g.x }));
      }
      if (run.length) out.push(textRun(doc, run, cp, base, lb.em, null, run[0].look));
    }
    let run = [];
    let runKey = null;
    const flush = () => {
      if (!run.length) return;
      const g0 = run[0];
      const cp = doc.H.charPr.get(String(g0.cp));
      const size = g0.size * (g0.sup ? SUPSUB_SIZE : 1);
      const y = g0.sup ? base - g0.size * 0.38 : base;
      out.push(textRun(doc, run, cp, y, size, line.squeeze, g0.look));
      run = [];
    };
    for (const g of glyphs) {
      if (g.obj) {
        flush();
        const o = g.obj;
        const x = ox + g.x * 1 + o.out[0];
        const top = oy + (line.objOnly ? o.out[2] : line.height - o.height + o.out[2]);
        drawObject(doc, o, x, top, out, defs, env);
        continue;
      }
      if (g.ch === ' ' || g.ch === ' ' || g.ch === '\t' || HANGING.has(g.ch) || ZERO_WIDTH.has(g.ch) || g.ch === '\n') { flush(); continue; }
      const sym = symbolOf(g.ch);
      if (sym) {
        flush();
        out.push(symbolSvg(doc, g, sym, ox, base));
        continue;
      }
      const key = g.cp + (g.sup ? 's' : '') + (g.page ? 'p' : '');
      if (key !== runKey) { flush(); runKey = key; }
      run.push(Object.assign({}, g, { x: ox + g.x, ch: g.page ? (env && env.pageText ? env.pageText : g.ch) : g.ch }));
    }
    flush();
    // 밑줄·취소선
    let seg = null;
    const segs = [];
    for (const g of glyphs) {
      const cp = doc.H.charPr.get(String(g.cp));
      if (cp && (cp.underline || cp.strike) && !g.obj && g.ch !== '\n') {
        if (seg && seg.cp === cp) seg.x2 = ox + g.x + g.adv;
        else { seg = { cp, x1: ox + g.x, x2: ox + g.x + g.adv, size: g.size }; segs.push(seg); }
      } else seg = null;
    }
    for (const s of segs) {
      if (s.cp.underline) {
        const y = s.cp.underline.type === 'TOP' ? base - s.size * 0.88 : base + s.size * 0.1;
        out.push(lineSvg(s.x1, y, s.x2, y, { type: s.cp.underline.shape || 'SOLID', width: Math.max(s.size * 0.05, 20), color: s.cp.underline.color || s.cp.textColor }));
      }
      if (s.cp.strike) {
        const y = base - s.size * 0.32;
        out.push(lineSvg(s.x1, y, s.x2, y, { type: s.cp.strike.shape || 'SOLID', width: Math.max(s.size * 0.05, 20), color: s.cp.strike.color || s.cp.textColor }));
      }
    }
  }
  const ANCHOR_START = new Set(Array.from('’”」』》〉】〕)]},.:;!?、。'));
  const ANCHOR_END = new Set(Array.from('‘“「『《〈【〔([{'));
  /** 같은 모양 글자 묶음 하나. 글자마다 자리(x)를 정해 두고, 대신 쓰는 글꼴의 글자는 그 칸 안에 맞춘다
   *  (닫는 부호는 칸 왼쪽, 여는 부호는 칸 오른쪽, 나머지는 칸 가운데). */
  function textRun(doc, run, cp, y, size, squeeze, look) {
    const face = look ? look.hangulFace : (cp ? fontFace(doc.H, cp, 'hangul') : '');
    const [family, normal, bold] = fontFor(face);
    const weight = cp && cp.bold ? bold : normal;
    const ratio = (cp && cp.ratio.hangul) || 100;
    const sx = (ratio / 100) * (squeeze || 1);
    const fill = cp ? cp.textColor : '#000000';
    const italic = cp && cp.italic ? ' font-style="italic"' : '';
    const tr = sx !== 1 ? ` transform="scale(${+sx.toFixed(4)},1)"` : '';
    let shade = '';
    if (cp && cp.shadeColor && run.length) {
      const x1 = run[0].x, x2 = run[run.length - 1].x + run[run.length - 1].adv;
      shade = `<rect x="${r1(x1)}" y="${r1(y - size * 0.85)}" width="${r1(x2 - x1)}" height="${r1(size)}" fill="${cp.shadeColor}"/>`;
    }
    const groups = { start: [], middle: [], end: [] };
    for (const g of run) {
      const cell = (g.plain || g.adv) * (squeeze || 1) * (g.sup ? 1 : 1);
      const kind = ANCHOR_START.has(g.ch) ? 'start' : ANCHOR_END.has(g.ch) ? 'end' : 'middle';
      const ax = kind === 'start' ? g.x : kind === 'end' ? g.x + cell : g.x + cell / 2;
      groups[kind].push([ax, g.ch === GLYPH_SPACE ? '　' : g.ch]);
    }
    let svg = shade;
    for (const kind of ['middle', 'start', 'end']) {
      const list = groups[kind];
      if (!list.length) continue;
      const xs = list.map(([ax]) => r1(ax / sx)).join(' ');
      const txt = esc(list.map(([, ch]) => ch).join(''));
      svg += `<text x="${xs}" y="${r1(y)}" text-anchor="${kind}" font-family="${esc(family)}" font-size="${r1(size)}" font-weight="${weight}"${italic} fill="${fill}"${tr}>${txt}</text>`;
    }
    return svg;
  }
  function symbolSvg(doc, g, sym, ox, base) {
    const cp = doc.H.charPr.get(String(g.cp));
    const size = g.size * (g.sup ? SUPSUB_SIZE : 1);
    const fill = cp ? cp.textColor : '#000000';
    const x = ox + g.x;
    if (sym.box || sym.boxFilled) {
      const s = size * 0.84;
      const top = base - size * 0.78;
      const w = Math.min(g.adv, size) * 0.84;
      const left = x + (g.adv - w) / 2;
      const filled = !!sym.boxFilled;
      const label = sym.box || sym.boxFilled;
      return `<rect x="${r1(left)}" y="${r1(top)}" width="${r1(w)}" height="${r1(s)}" fill="${filled ? fill : 'none'}" stroke="${fill}" stroke-width="${r1(size * 0.055)}"/>` +
        `<text x="${r1(left + w / 2)}" y="${r1(top + s * 0.79)}" text-anchor="middle" font-family="${esc(NOTO_SANS)}" font-weight="700" font-size="${r1(s * (label.length > 1 ? 0.72 : 0.86))}" fill="${filled ? '#FFFFFF' : fill}">${esc(label)}</text>`;
    }
    if (sym.shape === 'wd-v') { // Wingdings v(❖): 마름모 네 개
      const cell = g.plain || g.adv;
      const cx = x + cell / 2, cy = base - size * 0.36;
      const d = size * 0.15, off = size * 0.2;
      const one = (dx, dy) => `M${r1(cx + dx)} ${r1(cy + dy - d)}L${r1(cx + dx + d)} ${r1(cy + dy)}L${r1(cx + dx)} ${r1(cy + dy + d)}L${r1(cx + dx - d)} ${r1(cy + dy)}Z`;
      return `<path d="${one(0, -off)}${one(off, 0)}${one(0, off)}${one(-off, 0)}" fill="${fill}"/>`;
    }
    const [family] = fontFor(cp ? fontFace(doc.H, cp, 'hangul') : '');
    return `<text x="${r1(x)}" y="${r1(base)}" font-family="${esc(family)}, 'Apple Symbols', 'Segoe UI Symbol', sans-serif" font-size="${r1(size)}" fill="${fill}">${esc(sym.char)}</text>`;
  }

  /** 문단 여러 개를 (x, y)부터 차례로 그린다(표 칸·머리말·각주). 마지막 줄 바닥 y를 돌려준다. */
  function drawStack(doc, lays, x, y, out, defs, env) {
    let bottom = y;
    lays.forEach((l, p) => {
      if (p > 0) y += l.prev;
      drawParaDecor(doc, l, x, y, out, defs, env);
      for (let k = 0; k < l.lines.length; k++) {
        drawLine(doc, l, k, x, y, out, defs, env);
        bottom = y + l.lines[k].height;
        y += l.lines[k].advance;
      }
      y += l.next;
    });
    return bottom;
  }
  function drawParaDecor(doc, l, x, y, out, defs, env) {
    // 글과 따로 놓인 개체(글 위에)·떠 있는 개체
    if (l.anchored && !l.flowTable) {
      const a = l.anchored;
      const off = a.pos ? Math.max(signed32(num(a.pos.getAttribute('vertOffset'))), 0) : 0;
      const hx = a.pos ? signed32(num(a.pos.getAttribute('horzOffset'))) : 0;
      let ax = x + l.pp.left + hx + a.out[0];
      const halign = a.pos ? a.pos.getAttribute('horzAlign') : 'LEFT';
      const avail = l.width - l.pp.left - l.pp.right;
      if (halign === 'CENTER') ax = x + l.pp.left + (avail - a.width) / 2 + a.out[0];
      else if (halign === 'RIGHT') ax = x + l.pp.left + avail - a.width + a.out[0];
      drawObject(doc, a, ax, y + off + a.out[2], out, defs, env);
    }
    for (const f of l.floating) {
      const hx = f.pos ? signed32(num(f.pos.getAttribute('horzOffset'))) : 0;
      const vy = f.pos ? signed32(num(f.pos.getAttribute('vertOffset'))) : 0;
      const relH = f.pos ? f.pos.getAttribute('horzRelTo') : 'COLUMN';
      const relV = f.pos ? f.pos.getAttribute('vertRelTo') : 'PARA';
      const fx = (relH === 'PAPER' && env && env.paper ? -env.paper.x : x) + hx + f.out[0];
      const fy = (relV === 'PAPER' && env && env.paper ? -env.paper.y : relV === 'PAGE' && env && env.paper ? env.paper.bodyTop - env.paper.y : y) + vy + f.out[2];
      drawObject(doc, f, fx, fy, out, defs, env);
    }
  }
  function drawObject(doc, o, x, y, out, defs, env) {
    if (o.name === 'tbl') {
      const tl = o.layout || o.layout;
      if (tl) drawTable(doc, tl, x, y, out, defs, env, null);
      return;
    }
    const w = o.w !== undefined ? o.w : o.width - o.out[0] - o.out[1];
    const h = o.h !== undefined ? o.h : o.height - o.out[2] - o.out[3];
    if (o.name === 'pic') {
      const img = firstDesc(o.el, 'img');
      const ref = img ? img.getAttribute('binaryItemIDRef') : null;
      const url = ref && env && env.imageUrl ? env.imageUrl(ref) : null;
      if (url) out.push(`<image href="${esc(url)}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" preserveAspectRatio="none"/>`);
      else out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="#EEF0F4" stroke="#B8BECB" stroke-width="20"/>`);
      return;
    }
    if (['rect', 'ellipse', 'line', 'polygon', 'curve', 'arc', 'connectLine', 'container'].includes(o.name)) {
      const ls = firstDesc(o.el, 'lineShape');
      const stroke = ls && ls.getAttribute('style') !== 'NONE' ? colorOf(ls.getAttribute('color'), '#000000') : 'none';
      const sw = ls ? Math.max(num(ls.getAttribute('width'), 33), 10) : 33;
      const brush = firstDesc(o.el, 'winBrush');
      const fill = brush ? colorOf(brush.getAttribute('faceColor'), 'none') || 'none' : 'none';
      if (o.name === 'ellipse') out.push(`<ellipse cx="${r1(x + w / 2)}" cy="${r1(y + h / 2)}" rx="${r1(w / 2)}" ry="${r1(h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
      else if (o.name === 'line' || o.name === 'connectLine') out.push(`<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x + w)}" y2="${r1(y + h)}" stroke="${stroke === 'none' ? '#000' : stroke}" stroke-width="${sw}"/>`);
      else out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
      const dt = firstDesc(o.el, 'drawText');
      const sub = dt ? kid(dt, 'subList') : null;
      if (sub && env && env.ctx) {
        const tm = kid(dt, 'textMargin');
        const ml = num(tm && tm.getAttribute('left'), 283), mr = num(tm && tm.getAttribute('right'), 283), mt = num(tm && tm.getAttribute('top'), 283);
        const lays = kids(sub, 'p').map(parseParagraph).map((p) => layoutParagraph(env.ctx, p, Math.max(w - ml - mr, 1000), { noNotes: true }));
        drawStack(doc, lays, x + ml, y + mt, out, defs, env);
      }
      return;
    }
    out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="#F3F4F7" stroke="#9AA3B5" stroke-width="20" stroke-dasharray="120 80"/>`);
    out.push(`<text x="${r1(x + w / 2)}" y="${r1(y + h / 2 + 300)}" text-anchor="middle" font-family="${esc(NOTO_SANS)}" font-size="900" fill="#69718A">${esc({ equation: '수식', chart: '차트', ole: 'OLE 개체', video: '동영상', textart: '글맵시' }[o.name] || o.name)}</text>`);
  }
  /** 표를 그린다. seg가 있으면 흐르는 표의 한 조각(행들)만 그린다. */
  function drawTable(doc, tl, x, y, out, defs, env, seg) {
    const H = doc.H;
    const bfOf = (id) => H.borderFill.get(String(id));
    const borders = [];
    const drawCell = (c, top, h, shift, cut, keep) => {
      const bf = bfOf(c.bf);
      const cx = x + c.x, cy = top;
      if (bf && bf.fill) fillSvg(bf.fill, cx, cy, c.width, h, out, defs);
      // 내용(세로 정렬은 칸 전체 높이 기준, 쪽에서 잘린 칸은 위쪽 맞춤)
      const clipId = 'c' + (defs.n = (defs.n || 0) + 1);
      const needClip = !!(shift || cut);
      const innerH = c.h - c.margins.top - c.margins.bottom;
      let off = 0;
      if (!needClip) {
        if (c.valign === 'CENTER') off = (innerH - c.content) / 2;
        else if (c.valign === 'BOTTOM') off = innerH - c.content;
      }
      const contentY = cy + c.margins.top + off + c.before - (shift || 0);
      if (needClip) {
        const clipH = keep !== undefined ? Math.min(h, c.margins.top + keep) : h;
        defs.list.push(`<clipPath id="${clipId}"><rect x="${r1(cx)}" y="${r1(cy)}" width="${r1(c.width)}" height="${r1(clipH)}"/></clipPath>`);
        out.push(`<g clip-path="url(#${clipId})">`);
      }
      drawStack(doc, c.lays, cx + c.margins.left, contentY, out, defs, env);
      if (needClip) out.push('</g>');
      if (bf) {
        borders.push(lineSvg(cx, cy, cx + c.width, cy, bf.top));
        borders.push(lineSvg(cx, cy + h, cx + c.width, cy + h, bf.bottom));
        borders.push(lineSvg(cx, cy, cx, cy + h, bf.left));
        borders.push(lineSvg(cx + c.width, cy, cx + c.width, cy + h, bf.right));
        if (bf.slash) borders.push(lineSvg(cx, cy + h, cx + c.width, cy, bf.diagonal || { type: 'SOLID', width: 28, color: '#000000' }));
        if (bf.backSlash) borders.push(lineSvg(cx, cy, cx + c.width, cy + h, bf.diagonal || { type: 'SOLID', width: 28, color: '#000000' }));
      }
    };
    if (!seg) {
      for (const c of tl.cells) drawCell(c, y + c.y, c.h, 0, false);
    } else {
      let yy = y;
      for (const ri of seg.repeat || []) { // 쪽마다 되풀이하는 머리행
        const row = tl.rows[ri];
        for (const c of row.cells) if (c.rowSpan === 1) drawCell(c, yy, row.height, 0, false);
        yy += row.height;
      }
      const partOf = new Map(), partY = new Map();
      for (const part of seg.parts) { partOf.set(part.row, part); partY.set(part.row, yy); yy += part.height; }
      const done = new Set();
      for (const part of seg.parts) {
        for (const c of tl.cells) {
          if (done.has(c) || c.ri > part.row || c.ri + c.rowSpan - 1 < part.row) continue;
          let h = 0, firstRow = null;
          for (let r = c.ri; r < c.ri + c.rowSpan; r++) {
            if (!partOf.has(r)) continue;
            h += partOf.get(r).height;
            if (firstRow === null) firstRow = r;
          }
          if (firstRow === null) continue;
          done.add(c);
          const p0 = partOf.get(firstRow);
          let shift = p0.shift || 0;
          for (let r = c.ri; r < firstRow; r++) shift += tl.rows[r].height;
          const whole = !shift && Math.abs(h - c.h) < 1;
          drawCell(c, partY.get(firstRow), h, shift, !whole, c.rowSpan === 1 ? p0.keep : undefined);
        }
      }
    }
    for (const b of borders) out.push(b);
    if (tl.spacing > 0) {
      const bf = bfOf(tl.bf);
      if (bf) {
        out.push(lineSvg(x, y, x + tl.width, y, bf.top));
        out.push(lineSvg(x, y + tl.height, x + tl.width, y + tl.height, bf.bottom));
        out.push(lineSvg(x, y, x, y + tl.height, bf.left));
        out.push(lineSvg(x + tl.width, y, x + tl.width, y + tl.height, bf.right));
      }
    }
  }

  function pageNumberText(n, ctrl) {
    let s = numberText(n, ctrl.format === 'DIGIT' ? 'DIGIT' : ctrl.format);
    if (ctrl.side) s = ctrl.side + ' ' + s + ' ' + ctrl.side;
    return s;
  }

  /** 쪽 하나를 SVG 문자열로 그린다. */
  function renderPageSvg(doc, page, env) {
    const S = page.section;
    const W = S.width, Hh = S.height;
    const out = [];
    const defs = { list: [], n: 0 };
    const left = S.margins.left + S.margins.gutter;
    const top = S.margins.top + S.margins.header;
    const colX = (col) => {
      const cols = page.cols;
      if (cols.widths) { let x = left; for (let i = 0; i < col; i++) x += cols.widths[i] + (cols.gaps ? cols.gaps[i] : 0); return x; }
      return left + col * (cols.width + cols.gap);
    };
    env = Object.assign({}, env, { paper: { x: 0, y: 0, bodyTop: top }, pageText: String(page.number) });
    // 머리말
    if (page.header && page.header.length) drawStack(doc, page.header, left, S.margins.top, out, defs, env);
    // 본문 줄
    for (const it of page.items) {
      const x = colX(it.col);
      const lay = it.lay;
      if (it.line === 0) drawParaDecor(doc, lay, x, it.y + top - lay.prev * 0 , out, defs, env);
      drawLine(doc, lay, it.line, x, top + it.y, out, defs, env);
    }
    // 흐르는 표
    for (const f of page.flows) {
      const t = f.table;
      const lay = t.obj;
      const x = colX(f.col) + horzOfTable(t, page.cols.width);
      drawTable(doc, t.layout, x, top + f.seg.top, out, defs, env, f.seg);
      void lay;
    }
    // 각주
    if (page.notes.length) {
      const sh = S.footNote;
      let total = 0;
      page.notes.forEach((n, i) => { total += n.height + (i ? sh.between : 0); });
      const area = noteArea(sh, total, page.notes.length);
      const areaTop = top + S.body - area;
      const lineY = areaTop + sh.above;
      const len = sh.lineLength > 0 && sh.lineLength < page.cols.width ? sh.lineLength : page.cols.width / 3;
      out.push(lineSvg(left, lineY + sh.line / 2, left + len, lineY + sh.line / 2, { type: sh.lineType, width: Math.max(sh.line, 20), color: sh.lineColor }));
      let y = lineY + sh.line + sh.below;
      page.notes.forEach((n, i) => {
        if (i) y += sh.between;
        drawStack(doc, n.lays, left, y, out, defs, env);
        y += n.height;
      });
    }
    // 미주
    if (page.endSep) {
      const sh = S.endNote;
      const x = colX(page.endSep.col);
      const len = sh.lineLength > 0 && sh.lineLength < page.cols.width ? sh.lineLength : page.cols.width / 3;
      out.push(lineSvg(x, top + page.endSep.y + sh.line / 2, x + len, top + page.endSep.y + sh.line / 2, { type: sh.lineType, width: Math.max(sh.line, 20), color: sh.lineColor }));
    }
    for (const it of page.endItems || []) drawLine(doc, it.lay, it.line, colX(it.col), top + it.y, out, defs, env);
    // 꼬리말
    if (page.footer && page.footer.length) drawStack(doc, page.footer, left, top + S.body, out, defs, env);
    // 쪽 번호
    if (page.pageNum) {
      const ctrl = page.pageNum;
      const cp = doc.H.charPr.get(String(ctrl.cp));
      const size = cp ? cp.height : 1000;
      const txt = pageNumberText(page.number, ctrl);
      const pos = ctrl.pos;
      const [family, normal, bold] = fontFor(cp ? fontFace(doc.H, cp, 'hangul') : '');
      const weight = cp && cp.bold ? bold : normal;
      const isTop = /^TOP/.test(pos);
      const y = isTop ? S.margins.top + size * 0.85 : Hh - S.margins.bottom - size * 0.15;
      let x = left + S.textWidth / 2, anchor = 'middle';
      if (/LEFT/.test(pos)) { x = left; anchor = 'start'; }
      if (/RIGHT/.test(pos)) { x = left + S.textWidth; anchor = 'end'; }
      if (pos !== 'NONE') out.push(`<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" fill="${cp ? cp.textColor : '#000'}">${esc(txt)}</text>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="100%" height="100%" role="img" aria-label="${page.index + 1}쪽" style="white-space:pre">` +
      (defs.list.length ? `<defs>${defs.list.join('')}</defs>` : '') + `<rect width="${W}" height="${Hh}" fill="#FFFFFF"/>` + out.join('') + '</svg>';
  }
  function horzOfTable(t, colWidth) {
    const pos = t.obj.pos;
    const align = pos ? pos.getAttribute('horzAlign') : 'LEFT';
    const off = pos ? signed32(num(pos.getAttribute('horzOffset'))) : 0;
    const w = t.layout.width + t.layout.out[0] + t.layout.out[1];
    let x = off;
    if (align === 'CENTER') x = (colWidth - w) / 2 + off;
    else if (align === 'RIGHT') x = colWidth - w - off;
    return x + t.layout.out[0];
  }

  // ------------------------------------------------------------------ 시험용: python-hwpx 추정과 견줄 덤프
  function debugDump(doc) {
    const sec = doc.debug[0];
    const res = { pages: doc.pages.length, body: [], lines: [], cells: {} };
    const toPy = (lay) => {
      const src = lay.content.src;
      const idx = [];
      let n = 0;
      for (let i = 0; i < src.length; i++) { idx.push(n); if (src[i] === 't') n++; }
      idx.push(n);
      return { text: lay.content.text.filter((_, i) => src[i] === 't').join(''), starts: lay.lines.map((l) => idx[l.start]) };
    };
    const where = new Map();
    for (const page of doc.pages) for (const it of page.items) {
      if (!where.has(it.lay)) where.set(it.lay, []);
      where.get(it.lay).push([page.index, it.y]);
    }
    sec.lays.forEach((lay) => { res.body.push(toPy(lay)); res.lines.push(where.get(lay) || []); });
    descendants(sec.secEl, 'tbl').forEach((tbl, n) => {
      const tl = tbl.__layout;
      if (!tl) return;
      for (const c of tl.cells) res.cells[`t${n}r${c.row}c${c.col}`] = c.lays.map(toPy);
      res.cells[`t${n}rows`] = tl.rows.map((r) => r.height);
    });
    return res;
  }

  global.HwpxEngine = {
    readPackage, layoutDocument, renderPageSvg, fontFor, charAdvance, hancomLineStarts, makeStyle, debugDump,
    version: '1.0',
  };
})(typeof window !== 'undefined' ? window : globalThis);
