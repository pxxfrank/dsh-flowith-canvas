window.__ModuleLoader__.load({
  id: '@local/flowith-canvas',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */
    const STORE_V2 = 'dsh.flowith.canvas.v2';
    const STORE_V1 = 'dsh.flowith.canvas.v1';
    const API = '/flowith-api/ask';
    const CARD_W = 300;
    const COL_GAP = 96;
    /* 略高于最高的卡片（长笔记约 330px），自动布局时不会互相压住 */
    const ROW_GAP = 344;

    /* ------------------------------------------------------------------ *
     * 语言
     * ------------------------------------------------------------------ */
    let localeService = null;
    let lang = 'zh';

    function syncLang() {
      try {
        const active = String(localeService.getLocale().active || '');
        lang = /^zh/i.test(active) ? 'zh' : 'en';
      } catch {
        lang = 'zh';
      }
    }

    /** 中英文内联文案；英文缺省时回落到中文，避免出现空标签。 */
    function t(zh, en) {
      if (lang === 'zh') return zh;
      return en == null || en === '' ? zh : en;
    }

    /* ------------------------------------------------------------------ *
     * 提示词
     * ------------------------------------------------------------------ */
    const RULES = [
      '你是用户的结构化思考伙伴，工作在「节点式思考」画布上：每张卡片只回答一个问题。',
      '',
      '输出规范：',
      '1. 第一行用一句话给出结论，不加任何标题。',
      '2. 之后按需分节，节标题用三级标题（###）。可用的节：依据、关键假设、反例与风险、下一步。不必每节都写。',
      '3. 简洁的中文，不寒暄、不复述问题、不写「好的」「以下是」之类的话。',
      '4. 涉及事实、数字、时间点时标注不确定性；不知道就直说，不要编造。',
      '5. 全文控制在 350 字以内，只有用户明确要求时才展开。',
      '6. 只用 Markdown 的 ###、短横线列表和 **加粗**，不要表格，不要代码块。',
    ].join('\n');

    const SYSTEM_ASK = RULES;

    const SYSTEM_FUSE = RULES + '\n\n' + [
      '本次任务是把多张卡片融合成一个新结论：',
      '1. 先给出这些卡片共同支撑的结论；',
      '2. 再指出它们彼此矛盾、重复或互补的地方；',
      '3. 最后给出整合之后真正可执行的下一步。',
    ].join('\n');

    const SYSTEM_STEP = RULES + '\n\n' + [
      '这张卡片是一次编排中的一步，前面的卡片已经给出阶段结论。',
      '直接推进这一步，不要重复前面的内容；如果前面的结论有错，先纠正再继续。',
    ].join('\n');

    const SYSTEM_PLAN = [
      '你是思考编排器。用户给出一个目标，你把它拆成 3 到 5 个循序渐进的子问题。',
      '每个子问题都必须可以独立回答，并且回答完之后能让下一步更清楚。',
      '',
      '只输出一个 JSON 对象，不要代码块标记，不要任何解释或前后缀：',
      '{"title":"不超过 12 个字的图谱名","steps":[{"title":"不超过 10 个字","prompt":"这一问要回答的具体问题"}]}',
    ].join('\n');

    function systemFor(kind) {
      if (kind === 'fuse') return SYSTEM_FUSE;
      if (kind === 'step') return SYSTEM_STEP;
      return SYSTEM_ASK;
    }

    function clip(text, max) {
      const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      if (value.length <= max) return value;
      return value.slice(0, Math.max(0, max - 1)) + '…';
    }

    /** 笔记卡片的标题取第一行有内容的文字。 */
    function firstLineOf(text) {
      const line = String(text == null ? '' : text)
        .split('\n')
        .find((item) => item.trim());
      return line ? line.trim() : '';
    }

    /** 关系标注的快捷词，跟随界面语言。 */
    function relationChips() {
      return t(
        '因为|因此|前提是|但是|反驳|支撑|对比|导致',
        'because|therefore|requires|but|refutes|supports|contrast|leads to',
      ).split('|');
    }

    function buildPrompt(node, graph) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const parents = (node.parents || []).map((id) => byId.get(id)).filter(Boolean);
      const lines = [];
      let labelled = false;

      if (parents.length) {
        lines.push('【已有卡片】');
        parents.forEach((parent) => {
          const relation = parent && node.relations ? node.relations[parent.id] : '';
          if (relation) labelled = true;
          lines.push('· 「' + parent.title + '」' + (relation ? '（关系：' + relation + '）' : ''));
          if (parent.kind === 'note') {
            lines.push('  我的想法：' + clip(parent.answer || parent.prompt, 1400));
          } else {
            lines.push('  问题：' + clip(parent.prompt, 400));
            if (parent.answer) lines.push('  结论：' + clip(parent.answer, 1400));
          }
        });
        if (labelled) {
          lines.push('（「关系」是用户亲手标注的卡片联系，请按它理解这些卡片如何相连。）');
        }
        lines.push('');
      }

      /* 用户自己连出来的关联卡片（不是父子，只是画布上的联系） */
      const links = (graph.links || []).filter((link) => link.from === node.id || link.to === node.id);
      if (links.length) {
        lines.push('【关联卡片】');
        links.slice(0, 3).forEach((link) => {
          const otherId = link.from === node.id ? link.to : link.from;
          const other = byId.get(otherId);
          if (!other) return;
          const body = other.kind === 'note' ? other.answer || other.prompt : other.answer;
          lines.push('· 与「' + other.title + '」的关系：' + (link.label || '相关'));
          if (body) lines.push('  摘要：' + clip(body, 320));
        });
        lines.push('（这些关联由用户亲手连出，不是父子卡片，按需参考即可。）');
        lines.push('');
      }

      const onlyNotes = parents.length > 0 && parents.every((parent) => parent.kind === 'note');

      if (node.kind === 'fuse') {
        lines.push('【本次任务】把上面 ' + parents.length + ' 张卡片融合成一个新结论。');
        lines.push('要回答的问题：' + node.prompt);
      } else if (node.kind === 'step') {
        lines.push('【本次任务】继续推进这一步：' + node.prompt);
      } else if (parents.length) {
        lines.push(
          '【本次任务】' + (onlyNotes ? '基于我的想法回答：' : '在上一张卡片的基础上回答：') + node.prompt,
        );
      } else {
        lines.push('【本次任务】' + node.prompt);
      }
      return lines.join('\n');
    }

    /* ------------------------------------------------------------------ *
     * 流式桥（Host 路由返回 NDJSON）
     * ------------------------------------------------------------------ */
    function isAbort(error) {
      return Boolean(error) && (error.name === 'AbortError' || error.code === 20);
    }

    function messageOf(error) {
      if (!error) return t('未知错误', 'Unknown error');
      if (typeof error === 'string') return error;
      if (error.message) return String(error.message);
      return t('未知错误', 'Unknown error');
    }

    function parseEvent(line) {
      const text = line.trim();
      if (!text) return null;
      try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    }

    async function streamAsk(body, handlers, signal) {
      let response;
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
          cache: 'no-store',
        });
      } catch (error) {
        if (isAbort(error)) {
          if (handlers.onAbort) handlers.onAbort();
          return;
        }
        throw error;
      }

      if (!response.ok) {
        let message = 'HTTP ' + response.status;
        try {
          const payload = await response.json();
          if (payload && payload.error) message = payload.error;
        } catch {
          /* 非 JSON 错误体，保留状态码 */
        }
        throw new Error(message);
      }

      if (!response.body || !response.body.getReader) {
        const text = await response.text();
        const events = text.split('\n').map(parseEvent).filter(Boolean);
        events.forEach((event) => dispatch(event, handlers));
        if (handlers.onDone) handlers.onDone();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (isAbort(error)) {
            if (handlers.onAbort) handlers.onAbort();
            return;
          }
          throw error;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const event = parseEvent(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (event) dispatch(event, handlers);
        }
      }

      if (buffer.trim()) {
        const event = parseEvent(buffer);
        if (event) dispatch(event, handlers);
      }
      if (handlers.onDone) handlers.onDone();
    }

    function dispatch(event, handlers) {
      switch (event.t) {
        case 'meta':
          if (handlers.onMeta) handlers.onMeta(event);
          break;
        case 'text':
          if (handlers.onText) handlers.onText(String(event.d || ''));
          break;
        case 'reason':
          if (handlers.onReason) handlers.onReason(String(event.d || ''));
          break;
        case 'finish':
          if (handlers.onFinish) handlers.onFinish(event);
          break;
        case 'error':
          if (handlers.onError) handlers.onError(String(event.m || 'model request failed'));
          break;
        default:
          break;
      }
    }

    /* ------------------------------------------------------------------ *
     * 拓扑
     * ------------------------------------------------------------------ */
    function computeDepths(nodes) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const depth = new Map();
      const visiting = new Set();

      function walk(id) {
        if (depth.has(id)) return depth.get(id);
        if (visiting.has(id)) return 0;
        const node = byId.get(id);
        if (!node) return 0;
        visiting.add(id);
        const parents = (node.parents || []).filter((parentId) => byId.has(parentId));
        const value = parents.length ? Math.max.apply(null, parents.map(walk)) + 1 : 0;
        visiting.delete(id);
        depth.set(id, value);
        return value;
      }

      nodes.forEach((node) => walk(node.id));
      return depth;
    }

    function placeNode(graph, parentIds) {
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      const parents = (parentIds || []).map((id) => byId.get(id)).filter(Boolean);

      if (!parents.length) {
        const roots = graph.nodes.filter((node) => !(node.parents || []).length);
        return {
          x: 60,
          y: roots.length ? Math.max.apply(null, roots.map((node) => node.y)) + ROW_GAP : 40,
        };
      }

      const x = Math.max.apply(null, parents.map((node) => node.x)) + CARD_W + COL_GAP;
      let y = Math.min.apply(null, parents.map((node) => node.y));
      const taken = graph.nodes.filter((node) => Math.abs(node.x - x) < 12);
      const occupied = (candidate) => taken.some((node) => Math.abs(node.y - candidate) < ROW_GAP - 48);

      let guard = 0;
      while (occupied(y) && guard < 200) {
        y += ROW_GAP;
        guard += 1;
      }
      return { x, y };
    }

    /**
     * 卡片之间连线的锚点：父子边固定从父右到子左；自定义连线取「最近的一侧」，
     * 这样把卡片拖到任意位置后，线也不会从卡片背面穿出来。
     */
    function linkGeometry(a, b) {
      const forward = b.x >= a.x;
      return {
        from: { x: forward ? a.x + CARD_W : a.x, y: a.y + 26 },
        to: { x: forward ? b.x : b.x + CARD_W, y: b.y + 26 },
      };
    }

    function linkKeyOf(a, b) {
      return a < b ? a + '>' + b : b + '>' + a;
    }

    /* ------------------------------------------------------------------ *
     * 存储：多画布（v2）+ 兼容旧的单图谱（v1）
     * ------------------------------------------------------------------ */
    function boardNumber(id) {
      const match = /^b(\d+)$/.exec(String(id || ''));
      return match ? Number(match[1]) : 0;
    }

    function emptyBoard(title, seq) {
      const number = Number.isFinite(seq) && seq > 0 ? seq : 1;
      return {
        id: 'b' + number,
        title: title || t('未命名画布', 'Untitled board'),
        seq: 0,
        nodes: [],
        links: [],
        createdAt: Date.now(),
        updatedAt: 0,
      };
    }

    function normalizeNode(node) {
      const relations = {};
      if (node.relations && typeof node.relations === 'object') {
        Object.keys(node.relations).forEach((key) => {
          const value = node.relations[key];
          if (typeof value === 'string' && value.trim()) relations[key] = value.trim().slice(0, 60);
        });
      }
      return {
        id: node.id,
        title: typeof node.title === 'string' ? node.title : '',
        prompt: typeof node.prompt === 'string' ? node.prompt : '',
        answer: typeof node.answer === 'string' ? node.answer : '',
        reasoning: typeof node.reasoning === 'string' ? node.reasoning : '',
        status: node.status === 'running' ? 'done' : node.status || 'idle',
        error: typeof node.error === 'string' ? node.error : null,
        parents: Array.isArray(node.parents) ? node.parents.filter((id) => typeof id === 'string') : [],
        relations,
        kind: node.kind || 'ask',
        x: Number.isFinite(node.x) ? node.x : 60,
        y: Number.isFinite(node.y) ? node.y : 40,
        createdAt: Number.isFinite(node.createdAt) ? node.createdAt : Date.now(),
      };
    }

    function normalizeBoard(value, fallbackSeq) {
      const base = emptyBoard('', fallbackSeq);
      if (!value || typeof value !== 'object' || !Array.isArray(value.nodes)) return base;
      const nodes = value.nodes.filter((node) => node && typeof node.id === 'string').map(normalizeNode);
      const maxSeq = nodes.reduce((max, node) => {
        const match = /^n(\d+)$/.exec(node.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);

      /* 自定义连线：端点必须都在、不能自连、同一对卡片只保留一条 */
      const ids = new Set(nodes.map((node) => node.id));
      const links = [];
      const seen = new Set();
      if (Array.isArray(value.links)) {
        value.links.forEach((link) => {
          if (!link || typeof link !== 'object') return;
          const from = typeof link.from === 'string' ? link.from : '';
          const to = typeof link.to === 'string' ? link.to : '';
          if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) return;
          const key = linkKeyOf(from, to);
          if (seen.has(key)) return;
          seen.add(key);
          links.push({
            key,
            from,
            to,
            label: typeof link.label === 'string' ? link.label.trim().slice(0, 60) : '',
          });
        });
      }

      return {
        id: boardNumber(value.id) ? value.id : base.id,
        title: typeof value.title === 'string' && value.title ? value.title : base.title,
        seq: Math.max(Number.isFinite(value.seq) ? value.seq : 0, maxSeq),
        nodes,
        links,
        createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      };
    }

    function activeBoardOf(store) {
      return store.boards.find((board) => board.id === store.activeId) || store.boards[0];
    }

    function normalizeStore(value) {
      if (!value || typeof value !== 'object' || !Array.isArray(value.boards)) {
        const board = emptyBoard('', 1);
        return { version: 2, activeId: board.id, boardSeq: 1, boards: [board] };
      }
      const boards = value.boards
        .filter((board) => board && Array.isArray(board.nodes))
        .map((board, index) => normalizeBoard(board, index + 1));
      if (!boards.length) {
        const board = emptyBoard('', 1);
        return { version: 2, activeId: board.id, boardSeq: 1, boards: [board] };
      }
      const maxBoard = boards.reduce((max, board) => Math.max(max, boardNumber(board.id)), 0);
      return {
        version: 2,
        activeId: boards.some((board) => board.id === value.activeId) ? value.activeId : boards[0].id,
        boardSeq: Math.max(Number.isFinite(value.boardSeq) ? value.boardSeq : 1, maxBoard),
        boards,
      };
    }

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORE_V2);
        if (raw) return normalizeStore(JSON.parse(raw));
      } catch {
        /* 解析失败时落到迁移或空画布 */
      }
      try {
        const legacy = window.localStorage.getItem(STORE_V1);
        if (legacy) {
          const board = normalizeBoard(JSON.parse(legacy), 1);
          board.title = t('我的思考', 'My thinking');
          return { version: 2, activeId: board.id, boardSeq: 1, boards: [board] };
        }
      } catch {
        /* 旧数据不可用则忽略 */
      }
      const board = emptyBoard(t('未命名画布', 'Untitled board'), 1);
      return { version: 2, activeId: board.id, boardSeq: 1, boards: [board] };
    }

    function saveStore(store) {
      try {
        window.localStorage.setItem(STORE_V2, JSON.stringify(store));
      } catch {
        /* 配额或隐私模式：画布仍可用，只是不持久化 */
      }
    }

    /* ------------------------------------------------------------------ *
     * Markdown（只用 ###、列表、加粗、行内代码）
     * ------------------------------------------------------------------ */
    function inlineNodes(text, prefix) {
      const parts = String(text == null ? '' : text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
      const out = [];
      parts.forEach((part, index) => {
        if (!part) return;
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          out.push(h('strong', { key: prefix + 'b' + index }, part.slice(2, -2)));
        } else if (part.length > 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
          out.push(h('code', { key: prefix + 'c' + index }, part.slice(1, -1)));
        } else {
          out.push(part);
        }
      });
      return out;
    }

    function renderMarkdown(text) {
      const source = String(text == null ? '' : text).replace(/\r\n/g, '\n');
      const lines = source.split('\n');
      const out = [];
      let items = null;
      let listTag = null;

      const flushList = () => {
        if (!items) return;
        out.push(h(listTag, { key: 'l' + out.length }, items));
        items = null;
        listTag = null;
      };

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) {
          flushList();
          return;
        }
        let match;
        if ((match = /^#{1,6}\s+(.+)$/.exec(trimmed))) {
          flushList();
          out.push(h('h4', { key: 'h' + index, className: 'fc-h' }, inlineNodes(match[1], 'h' + index)));
          return;
        }
        if ((match = /^[-*·]\s+(.+)$/.exec(trimmed))) {
          if (listTag !== 'ul') {
            flushList();
            items = [];
            listTag = 'ul';
          }
          items.push(h('li', { key: 'li' + index }, inlineNodes(match[1], 'li' + index)));
          return;
        }
        if ((match = /^\d+[.)、]\s*(.+)$/.exec(trimmed))) {
          if (listTag !== 'ol') {
            flushList();
            items = [];
            listTag = 'ol';
          }
          items.push(h('li', { key: 'li' + index }, inlineNodes(match[1], 'ol' + index)));
          return;
        }
        flushList();
        out.push(h('p', { key: 'p' + index }, inlineNodes(trimmed, 'p' + index)));
      });

      flushList();
      return out;
    }

    /* ------------------------------------------------------------------ *
     * 图标
     * ------------------------------------------------------------------ */
    const PATHS = {
      spark: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
      plus: ['M12 5v14', 'M5 12h14'],
      minus: ['M5 12h14'],
      fit: ['M4 9V5h4', 'M20 9V5h-4', 'M4 15v4h4', 'M20 15v4h-4'],
      layout: ['M4 5h6v6H4z', 'M14 13h6v6h-6z', 'M10 8h4v5'],
      help: ['M12 18h.01', 'M9.1 9a3 3 0 116 .9c0 2-3 2.1-3 4.1'],
      trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'],
      send: ['M4 12l16-8-6 16-3-7z'],
      stop: ['M7 7h10v10H7z'],
      refresh: ['M4 11a8 8 0 0113.7-5.7L20 8', 'M20 4v4h-4', 'M20 13a8 8 0 01-13.7 5.7L4 16', 'M4 20v-4h4'],
      branch: ['M6 4v9a4 4 0 004 4h8', 'M14 13l4 4-4 4'],
      fuse: ['M5 7h5l4 5-4 5H5', 'M19 7h-5l-2 2.4', 'M19 17h-5l-2-2.4'],
      plan: ['M4 6h9', 'M4 12h6', 'M4 18h9', 'M17 8v8', 'M14 13l3 3 3-3'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      board: ['M4 5h7v6H4z', 'M14 13h6v6h-6z', 'M11 8h3v8'],
      chevron: ['M6 9l6 6 6-6'],
      link: ['M9.5 14.5l5-5', 'M11 6.5l1.6-1.6a3.5 3.5 0 014.9 4.9L15.9 11.4', 'M13 17.5l-1.6 1.6a3.5 3.5 0 01-4.9-4.9L8.1 12.6'],
      note: ['M5 5h10l4 4v10H5z', 'M15 5v4h4', 'M8 12h8', 'M8 16h5'],
      edit: ['M4 20h4L19 9l-4-4L4 16v4z', 'M13.5 6.5l4 4'],
    };

    function Icon(props) {
      const size = props && props.size ? props.size : 16;
      const paths = PATHS[props.name] || PATHS.spark;
      return h(
        'svg',
        {
          className: 'fc-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    /* ------------------------------------------------------------------ *
     * 卡片
     * ------------------------------------------------------------------ */
    function KindBadge(props) {
      const label =
        props.kind === 'note'
          ? t('想法', 'Note')
          : props.kind === 'fuse'
            ? t('融合', 'Fuse')
            : props.kind === 'step'
              ? t('编排步骤', 'Step')
              : props.kind === 'plan'
                ? t('编排', 'Plan')
                : props.kind === 'branch'
                  ? t('追问', 'Follow-up')
                  : t('提问', 'Ask');
      return h('span', { className: 'fc-kind is-' + props.kind }, label);
    }

    /* ------------------------------------------------------------------ *
     * 想法卡片：用户自己写的正文，随时可改
     * ------------------------------------------------------------------ */
    function NoteBody(props) {
      const inputRef = useRef(null);

      useEffect(() => {
        const element = inputRef.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = Math.max(56, Math.min(260, element.scrollHeight)) + 'px';
      }, [props.value]);

      return h('textarea', {
        ref: inputRef,
        className: 'fc-note-input',
        value: props.value,
        placeholder: t('写下你的判断、前提或疑问…', 'Write your own judgement, premise or doubt…'),
        spellCheck: false,
        onChange: (event) => props.onChange(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            props.onAsk();
          }
        },
      });
    }

    const NodeCard = React.memo(function NodeCard(props) {
      const node = props.node;
      const bodyRef = useRef(null);
      const answerLength = node.answer ? node.answer.length : 0;

      useEffect(() => {
        const element = bodyRef.current;
        if (!element) return;
        if (node.status === 'running') element.scrollTop = element.scrollHeight;
      }, [answerLength, node.status]);

      const onHeaderDown = useCallback(
        (event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          props.onDragStart(event, node.id);
        },
        [props.onDragStart, node.id],
      );

      const onCardClick = useCallback(
        (event) => {
          if (event.target && event.target.closest && event.target.closest('button, a, textarea, summary')) return;
          props.onSelect(node.id, event.metaKey || event.ctrlKey || event.shiftKey);
        },
        [props.onSelect, node.id],
      );

      const act = useCallback((action) => (event) => {
        event.stopPropagation();
        props.onAction(node.id, action);
      }, [props.onAction, node.id]);

      const isNote = node.kind === 'note';
      const classes = ['fc-card'];
      if (props.selected) classes.push('is-selected');
      if (node.status === 'running') classes.push('is-running');
      if (node.status === 'error') classes.push('is-error');
      if (isNote) classes.push('is-note');

      const showReasoning = node.reasoning && node.status === 'running' && !node.answer;

      return h(
        'article',
        {
          className: classes.join(' '),
          style: { left: node.x + 'px', top: node.y + 'px', width: CARD_W + 'px' },
          onClick: onCardClick,
          'data-node': node.id,
        },
        h(
          'header',
          { className: 'fc-card-head', onPointerDown: onHeaderDown, title: t('拖动卡片', 'Drag card') },
          h('span', { className: 'fc-dot is-' + node.status }),
          h('span', { className: 'fc-card-title' }, node.title || t('未命名', 'Untitled')),
          h(KindBadge, { kind: node.kind }),
          props.selected
            ? h('span', { className: 'fc-check' }, h(Icon, { name: 'spark', size: 11 }))
            : null,
        ),
        !isNote && node.prompt
          ? h('div', { className: 'fc-card-q' }, node.prompt)
          : null,
        isNote
          ? h(
              'div',
              { className: 'fc-card-body is-note' },
              h(NoteBody, {
                value: node.answer,
                onChange: (value) => props.onEditNote(node.id, value),
                onAsk: () => props.onAction(node.id, 'reply'),
              }),
            )
          : h(
              'div',
              { className: 'fc-card-body', ref: bodyRef },
              node.answer ? renderMarkdown(node.answer) : null,
              showReasoning ? h('div', { className: 'fc-think' }, clip(node.reasoning, 260)) : null,
              node.status === 'running' ? h('span', { className: 'fc-caret' }) : null,
              node.status === 'idle' && !node.answer
                ? h('span', { className: 'fc-muted' }, t('尚未运行', 'Not run yet'))
                : null,
              node.status === 'running' && !node.answer && !showReasoning
                ? h('span', { className: 'fc-muted' }, t('思考中…', 'Thinking…'))
                : null,
            ),
        node.error ? h('div', { className: 'fc-card-error' }, node.error) : null,
        h(
          'footer',
          { className: 'fc-card-foot' },
          isNote
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'fc-mini',
                  onClick: act('reply'),
                  title: t('基于这张想法去提问（⌘/Ctrl+Enter）', 'Ask a question from this note (⌘/Ctrl+Enter)'),
                },
                h(Icon, { name: 'branch', size: 13 }),
                t('据此提问', 'Ask from this'),
              )
            : node.status === 'running'
              ? h(
                  'button',
                  { type: 'button', className: 'fc-mini', onClick: act('stop'), title: t('停止', 'Stop') },
                  h(Icon, { name: 'stop', size: 13 }),
                  t('停止', 'Stop'),
                )
              : h(
                  'button',
                  { type: 'button', className: 'fc-mini', onClick: act('reply'), title: t('基于这张卡片继续追问', 'Ask on top of this card') },
                  h(Icon, { name: 'branch', size: 13 }),
                  t('追问', 'Ask'),
                ),
          !isNote && node.status !== 'running'
            ? h(
                'button',
                { type: 'button', className: 'fc-mini', onClick: act('rerun'), title: t('重新生成', 'Regenerate') },
                h(Icon, { name: 'refresh', size: 13 }),
                t('重来', 'Redo'),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'fc-mini is-danger', onClick: act('delete'), title: t('删除这张卡片', 'Delete card') },
            h(Icon, { name: 'trash', size: 13 }),
          ),
        ),
      );
    });

    /* ------------------------------------------------------------------ *
     * 页面
     * ------------------------------------------------------------------ */
    function FlowithPage() {
      const [store, setStore] = useState(loadStore);
      const [selection, setSelection] = useState([]);
      const [view, setView] = useState({ x: 48, y: 24, z: 1 });
      const [draft, setDraft] = useState('');
      const [mode, setMode] = useState('ask');
      const [helpOpen, setHelpOpen] = useState(false);
      const [notice, setNotice] = useState('');
      const [boardMenu, setBoardMenu] = useState(false);
      const [renaming, setRenaming] = useState(null);
      const [pendingDelete, setPendingDelete] = useState(null);
      const [linkEdit, setLinkEdit] = useState(null);
      const [linkDrag, setLinkDrag] = useState(null);
      const [tick, setTick] = useState(0);

      const board = activeBoardOf(store);
      const storeRef = useRef(store);
      const graphRef = useRef(board);
      const viewRef = useRef(view);
      const runsRef = useRef(new Map());
      const dragRef = useRef(null);
      const boardRef = useRef(null);
      const textareaRef = useRef(null);
      const saveTimer = useRef(0);
      const noticeTimer = useRef(0);
      const noticeRef = useRef('');

      /* ---- 保持 ref 与最新渲染同步 ---- */
      useEffect(() => {
        storeRef.current = store;
        graphRef.current = activeBoardOf(store);
      }, [store]);
      useEffect(() => {
        viewRef.current = view;
      }, [view]);

      /* ---- 本地持久化（节流） ---- */
      useEffect(() => {
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveStore(storeRef.current);
        }, 500);
        return () => {
          if (saveTimer.current) window.clearTimeout(saveTimer.current);
        };
      }, [store]);

      /* ---- 跟随宿主语言切换 ---- */
      useEffect(() => {
        if (!localeService) return undefined;
        let dispose = null;
        try {
          dispose = localeService.subscribe(() => {
            syncLang();
            setTick((value) => value + 1);
          });
        } catch {
          dispose = null;
        }
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, []);

      /* ---- 画布尺寸 / 空态居中 ---- */
      useEffect(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = Math.min(168, Math.max(46, element.scrollHeight)) + 'px';
      }, [draft]);

      const commit = useCallback((next) => {
        const current = storeRef.current;
        const stamped = { ...next, updatedAt: Date.now() };
        const nextStore = {
          ...current,
          boards: current.boards.map((item) => (item.id === stamped.id ? stamped : item)),
        };
        storeRef.current = nextStore;
        graphRef.current = stamped;
        setStore(nextStore);
      }, []);

      const updateGraph = useCallback(
        (project) => {
          commit(project(graphRef.current));
        },
        [commit],
      );

      const patchNode = useCallback(
        (id, patch) => {
          updateGraph((current) => ({
            ...current,
            nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
          }));
        },
        [updateGraph],
      );

      /* ---- 笔记编辑 / 关系标注 ---- */
      const editNote = useCallback(
        (id, value) => {
          updateGraph((current) => ({
            ...current,
            nodes: current.nodes.map((node) =>
              node.id === id
                ? { ...node, answer: value, title: clip(firstLineOf(value), 22) || t('想法', 'Thought') }
                : node,
            ),
          }));
        },
        [updateGraph],
      );

      const saveRelation = useCallback(
        (childId, parentId, value) => {
          const text = String(value == null ? '' : value).trim().slice(0, 60);
          updateGraph((current) => ({
            ...current,
            nodes: current.nodes.map((node) => {
              if (node.id !== childId) return node;
              const relations = { ...(node.relations || {}) };
              if (text) relations[parentId] = text;
              else delete relations[parentId];
              return { ...node, relations };
            }),
          }));
        },
        [updateGraph],
      );

      /* ---- 自定义连线（任意两张卡片之间） ---- */
      const saveLink = useCallback(
        (key, value) => {
          const text = String(value == null ? '' : value).trim().slice(0, 60);
          updateGraph((current) => ({
            ...current,
            links: (current.links || []).map((link) => (link.key === key ? { ...link, label: text } : link)),
          }));
        },
        [updateGraph],
      );

      const removeLink = useCallback(
        (key) => {
          updateGraph((current) => ({
            ...current,
            links: (current.links || []).filter((link) => link.key !== key),
          }));
        },
        [updateGraph],
      );

      /** 建连线；同一条已存在时只打开标注，不重复添加。 */
      const createLink = useCallback(
        (fromId, toId) => {
          if (!fromId || !toId || fromId === toId) return;
          const current = graphRef.current;
          const from = current.nodes.find((node) => node.id === fromId);
          const to = current.nodes.find((node) => node.id === toId);
          if (!from || !to) return;

          const key = linkKeyOf(fromId, toId);
          const existing = (current.links || []).find((link) => link.key === key);
          if (!existing) {
            commit({
              ...current,
              links: (current.links || []).concat([{ key, from: fromId, to: toId, label: '' }]),
            });
          }

          const geometry = linkGeometry(from, to);
          setLinkEdit({
            kind: 'link',
            linkKey: key,
            value: existing ? existing.label || '' : '',
            x: (geometry.from.x + geometry.to.x) / 2,
            y: (geometry.from.y + geometry.to.y) / 2,
          });
        },
        [commit],
      );

      const onLinkStart = useCallback((event, id) => {
        const element = boardRef.current;
        if (!element) return;
        event.stopPropagation();
        if (event.button !== 0) return;
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const current = viewRef.current;
        dragRef.current = {
          kind: 'link',
          from: id,
          x: event.clientX,
          y: event.clientY,
        };
        setLinkEdit(null);
        setLinkDrag({
          fromId: id,
          x: (event.clientX - rect.left - current.x) / current.z,
          y: (event.clientY - rect.top - current.y) / current.z,
        });
      }, []);

      const toast = useCallback((message) => {
        noticeRef.current = message;
        setNotice(message);
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => {
          if (noticeRef.current === message) setNotice('');
        }, 2600);
      }, []);

      /* ---- 流式写回（每帧一次，避免逐字重渲染） ---- */
      const flushRun = useCallback(
        (run) => {
          if (runsRef.current.get(run.id) !== run) return;
          updateGraph((current) => ({
            ...current,
            nodes: current.nodes.map((node) =>
              node.id === run.id ? { ...node, answer: run.answer, reasoning: run.reasoning } : node,
            ),
          }));
        },
        [updateGraph],
      );

      const scheduleFlush = useCallback(
        (run) => {
          if (run.frame) return;
          run.frame = window.requestAnimationFrame(() => {
            run.frame = 0;
            flushRun(run);
          });
        },
        [flushRun],
      );

      const startRun = useCallback(
        (id) => {
          const previous = runsRef.current.get(id);
          if (previous) {
            try {
              previous.controller.abort();
            } catch {
              /* 已结束 */
            }
          }
          const run = { id, controller: new AbortController(), answer: '', reasoning: '', frame: 0, error: null };
          runsRef.current.set(id, run);
          patchNode(id, { status: 'running', answer: '', reasoning: '', error: null });
          return run;
        },
        [patchNode],
      );

      const sendRun = useCallback(
        async (run, body) => {
          if (run.frame) {
            window.cancelAnimationFrame(run.frame);
            run.frame = 0;
          }
          run.answer = '';
          run.reasoning = '';
          try {
            await streamAsk(
              body,
              {
                onText: (delta) => {
                  run.answer += delta;
                  scheduleFlush(run);
                },
                onReason: (delta) => {
                  run.reasoning += delta;
                  scheduleFlush(run);
                },
                onError: (message) => {
                  run.error = message;
                },
                onFinish: (event) => {
                  if (event.reason === 'error' && event.failure && event.failure.message) {
                    run.error = String(event.failure.message);
                  }
                },
              },
              run.controller.signal,
            );
          } catch (error) {
            if (!isAbort(error)) run.error = messageOf(error);
          }
          if (run.frame) {
            window.cancelAnimationFrame(run.frame);
            run.frame = 0;
          }
          flushRun(run);
          return run.answer;
        },
        [flushRun, scheduleFlush],
      );

      const finishRun = useCallback(
        (run) => {
          if (runsRef.current.get(run.id) !== run) return;
          runsRef.current.delete(run.id);
          patchNode(run.id, {
            status: run.error ? 'error' : 'done',
            error: run.error || null,
            answer: run.answer,
            reasoning: run.reasoning,
          });
        },
        [patchNode],
      );

      /* ---- 建节点 ---- */
      const addNode = useCallback(
        (partial) => {
          const current = graphRef.current;
          const seq = current.seq + 1;
          const id = 'n' + seq;
          const parents = (partial.parents || []).filter(Boolean);
          const position = placeNode(current, parents);
          const node = {
            id,
            title: partial.title || t('未命名', 'Untitled'),
            prompt: partial.prompt || '',
            answer: partial.answer || '',
            reasoning: '',
            status: partial.status || 'idle',
            error: null,
            parents,
            relations: {},
            kind: partial.kind || 'ask',
            x: position.x,
            y: position.y,
            createdAt: Date.now(),
          };
          commit({ ...current, seq, nodes: current.nodes.concat([node]) });
          return id;
        },
        [commit],
      );

      /* 新卡片可能落在视口右侧之外，创建后把画布挪过去 */
      const revealNode = useCallback((id) => {
        const element = boardRef.current;
        const node = graphRef.current.nodes.find((item) => item.id === id);
        if (!element || !node) return;
        const rect = element.getBoundingClientRect();
        const current = viewRef.current;
        const left = node.x * current.z + current.x;
        const top = node.y * current.z + current.y;
        const width = CARD_W * current.z;
        const height = 230 * current.z;
        let nextX = current.x;
        let nextY = current.y;
        if (left + width > rect.width - 36) nextX = current.x - (left + width - (rect.width - 36));
        if (left < 24) nextX = current.x + (24 - left);
        if (top + height > rect.height - 156) nextY = current.y - (top + height - (rect.height - 156));
        if (top < 88) nextY = current.y + (88 - top);
        if (nextX === current.x && nextY === current.y) return;
        const next = { x: nextX, y: nextY, z: current.z };
        viewRef.current = next;
        setView(next);
      }, []);

      /* ---- 单节点运行 ---- */
      const runNode = useCallback(
        async (id) => {
          const node = graphRef.current.nodes.find((item) => item.id === id);
          if (!node || node.kind === 'note') return;
          const run = startRun(id);
          await sendRun(run, {
            prompt: buildPrompt(node, graphRef.current),
            system: systemFor(node.kind),
          });
          finishRun(run);
        },
        [finishRun, sendRun, startRun],
      );

      const runPlan = useCallback(
        async (goal, parentIds) => {
          const planId = addNode({ title: clip(goal, 18), prompt: goal, kind: 'plan', parents: parentIds });
          setSelection([planId]);
          revealNode(planId);
          const run = startRun(planId);
          await sendRun(run, {
            prompt: '目标：' + goal,
            system: SYSTEM_PLAN,
            maxTokens: 1200,
          });

          if (run.error) {
            finishRun(run);
            return;
          }

          const plan = parsePlan(run.answer);
          if (!plan || !plan.steps.length) {
            run.error = t(
              '编排器没有返回可执行的步骤。把目标写得更具体一些再试。',
              'The planner returned no usable steps. Try a more concrete goal.',
            );
            finishRun(run);
            return;
          }

          run.answer =
            '编排：' +
            (plan.title || t('思考路径', 'Thinking path')) +
            '\n\n' +
            plan.steps
              .map((step, index) => index + 1 + '. ' + step.title + ' — ' + clip(step.prompt, 120))
              .join('\n');
          finishRun(run);

          let previous = planId;
          for (let index = 0; index < plan.steps.length; index += 1) {
            const step = plan.steps[index];
            const stepId = addNode({
              title: step.title,
              prompt: step.prompt,
              kind: 'step',
              parents: [previous],
            });
            setSelection([stepId]);
            revealNode(stepId);
            const stepRun = startRun(stepId);
            await sendRun(stepRun, {
              prompt: buildPrompt(graphRef.current.nodes.find((item) => item.id === stepId), graphRef.current),
              system: SYSTEM_STEP,
            });
            finishRun(stepRun);
            previous = stepId;
          }
        },
        [addNode, finishRun, revealNode, sendRun, startRun],
      );

      /* ---- 提交 ---- */
      const submit = useCallback(() => {
        const text = draft.trim();
        if (!text) return;
        setDraft('');

        if (mode === 'note') {
          const id = addNode({
            title: clip(firstLineOf(text), 22) || t('想法', 'Thought'),
            prompt: '',
            kind: 'note',
            answer: text,
            status: 'note',
          });
          setSelection([id]);
          revealNode(id);
          return;
        }

        if (mode === 'plan') {
          runPlan(text, selection.slice(0, 3));
          return;
        }

        const parents = selection.slice(0, 4);
        const kind = parents.length >= 2 ? 'fuse' : parents.length === 1 ? 'branch' : 'ask';
        const id = addNode({ title: clip(text, 22), prompt: text, kind, parents });
        setSelection([id]);
        revealNode(id);
        runNode(id);
      }, [addNode, draft, mode, revealNode, runNode, runPlan, selection]);

      const onKeyDown = useCallback(
        (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        },
        [submit],
      );

      /* ---- 选择 / 动作 ---- */
      const selectNode = useCallback((id, additive) => {
        setSelection((previous) => {
          if (!additive) return previous.length === 1 && previous[0] === id ? previous : [id];
          return previous.includes(id) ? previous.filter((item) => item !== id) : previous.concat([id]);
        });
      }, []);

      const onAction = useCallback(
        (id, action) => {
          if (action === 'delete') {
            setLinkEdit(null);
            const run = runsRef.current.get(id);
            if (run) {
              try {
                run.controller.abort();
              } catch {
                /* 已结束 */
              }
              runsRef.current.delete(id);
            }
            updateGraph((current) => {
              const removed = new Set([id]);
              let nodes = current.nodes.filter((node) => node.id !== id);
              let changed = true;
              while (changed) {
                changed = false;
                nodes = nodes.filter((node) => {
                  if ((node.parents || []).some((parent) => removed.has(parent))) {
                    removed.add(node.id);
                    changed = true;
                    return false;
                  }
                  return true;
                });
              }
              return {
                ...current,
                nodes,
                links: (current.links || []).filter(
                  (link) => !removed.has(link.from) && !removed.has(link.to),
                ),
              };
            });
            setSelection((previous) => previous.filter((item) => item !== id));
            return;
          }

          if (action === 'rerun') {
            runNode(id);
            return;
          }

          if (action === 'stop') {
            const run = runsRef.current.get(id);
            if (run) {
              try {
                run.controller.abort();
              } catch {
                /* 已结束 */
              }
            }
            patchNode(id, { status: 'done' });
            return;
          }

          if (action === 'reply') {
            setSelection([id]);
            setMode('ask');
            const node = graphRef.current.nodes.find((item) => item.id === id);
            setTimeout(() => {
              const element = textareaRef.current;
              if (!element) return;
              element.focus();
              const length = element.value.length;
              element.setSelectionRange(length, length);
            }, 30);
            if (node && node.kind === 'note') return;
            setDraft((current) => current || t('接着「' + (node ? node.title : '') + '」继续想：', 'Following "' + (node ? node.title : '') + '": '));
          }
        },
        [patchNode, runNode, updateGraph],
      );

      /* ---- 拖动 ---- */
      const onDragStart = useCallback((event, id) => {
        const node = graphRef.current.nodes.find((item) => item.id === id);
        if (!node) return;
        dragRef.current = {
          kind: 'node',
          id,
          x: event.clientX,
          y: event.clientY,
          nx: node.x,
          ny: node.y,
          z: viewRef.current.z,
          moved: false,
        };
      }, []);

      const onBoardDown = useCallback((event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (
          target &&
          target.closest &&
          target.closest('.fc-card, .fc-dock, .fc-head, .fc-tools, .fc-rel, .fc-rel-edit, .fc-menu, .fc-port')
        ) {
          return;
        }
        setBoardMenu(false);
        setLinkEdit(null);
        setRenaming(null);
        setPendingDelete(null);
        dragRef.current = {
          kind: 'pan',
          x: event.clientX,
          y: event.clientY,
          vx: viewRef.current.x,
          vy: viewRef.current.y,
          moved: false,
        };
        setSelection([]);
      }, []);

      useEffect(() => {
        function onMove(event) {
          const drag = dragRef.current;
          if (!drag) return;

          /* 正在拉一条自定义连线：只更新预览线的终点 */
          if (drag.kind === 'link') {
            const element = boardRef.current;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const current = viewRef.current;
            setLinkDrag({
              fromId: drag.from,
              x: (event.clientX - rect.left - current.x) / current.z,
              y: (event.clientY - rect.top - current.y) / current.z,
            });
            return;
          }

          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (!drag.moved) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            drag.moved = true;
          }
          if (drag.kind === 'node') {
            const z = drag.z || 1;
            const nextX = Math.round(drag.nx + dx / z);
            const nextY = Math.round(drag.ny + dy / z);
            updateGraph((current) => ({
              ...current,
              nodes: current.nodes.map((node) => (node.id === drag.id ? { ...node, x: nextX, y: nextY } : node)),
            }));
          } else {
            const next = { x: drag.vx + dx, y: drag.vy + dy, z: viewRef.current.z };
            viewRef.current = next;
            setView(next);
          }
        }

        function onUp(event) {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag || drag.kind !== 'link') return;
          setLinkDrag(null);
          const element = document.elementFromPoint(event.clientX, event.clientY);
          const card = element && element.closest ? element.closest('[data-node]') : null;
          const targetId = card ? card.getAttribute('data-node') : null;
          if (targetId) createLink(drag.from, targetId);
        }

        function onCancel() {
          dragRef.current = null;
          setLinkDrag(null);
        }

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
        };
      }, [createLink, updateGraph]);

      /* ---- 缩放 ---- */
      const zoomAt = useCallback((px, py, factor) => {
        const current = viewRef.current;
        const z = Math.min(2.2, Math.max(0.3, current.z * factor));
        const ratio = z / current.z;
        const next = {
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
          z,
        };
        viewRef.current = next;
        setView(next);
      }, []);

      useEffect(() => {
        const element = boardRef.current;
        if (!element) return undefined;
        function onWheel(event) {
          event.preventDefault();
          const rect = element.getBoundingClientRect();
          if (event.ctrlKey || event.metaKey) {
            zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0016));
          } else {
            const current = viewRef.current;
            const next = { x: current.x - event.deltaX, y: current.y - event.deltaY, z: current.z };
            viewRef.current = next;
            setView(next);
          }
        }
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
      }, [zoomAt]);

      const zoomCenter = useCallback(
        (factor) => {
          const element = boardRef.current;
          if (!element) return;
          const rect = element.getBoundingClientRect();
          zoomAt(rect.width / 2, rect.height / 2, factor);
        },
        [zoomAt],
      );

      const fitView = useCallback(() => {
        const element = boardRef.current;
        const nodes = graphRef.current.nodes;
        if (!element || !nodes.length) {
          setView({ x: 48, y: 24, z: 1 });
          return;
        }
        const rect = element.getBoundingClientRect();
        const minX = Math.min.apply(null, nodes.map((node) => node.x));
        const minY = Math.min.apply(null, nodes.map((node) => node.y));
        const maxX = Math.max.apply(null, nodes.map((node) => node.x + CARD_W));
        const maxY = Math.max.apply(null, nodes.map((node) => node.y + 240));
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);
        const z = Math.min(1.25, Math.max(0.3, Math.min((rect.width - 140) / width, (rect.height - 200) / height)));
        setView({
          x: Math.round((rect.width - width * z) / 2 - minX * z),
          y: Math.round((rect.height - height * z) / 2 - minY * z + 20),
          z,
        });
      }, []);

      const autoLayout = useCallback(() => {
        updateGraph((current) => {
          const depth = computeDepths(current.nodes);
          const columns = new Map();
          const nodes = current.nodes.map((node) => {
            const column = depth.get(node.id) || 0;
            const row = columns.get(column) || 0;
            columns.set(column, row + 1);
            return { ...node, x: 60 + column * (CARD_W + COL_GAP), y: 40 + row * ROW_GAP };
          });
          return { ...current, nodes };
        });
        window.setTimeout(fitView, 30);
        toast(t('已重新布局', 'Layout applied'));
      }, [fitView, toast, updateGraph]);

      const abortRuns = useCallback(() => {
        runsRef.current.forEach((run) => {
          try {
            run.controller.abort();
          } catch {
            /* 已结束 */
          }
        });
        runsRef.current.clear();
      }, []);

      const clearAll = useCallback(() => {
        abortRuns();
        setSelection([]);
        setLinkEdit(null);
        updateGraph((current) => ({ ...current, seq: 0, nodes: [], links: [] }));
        setView({ x: 48, y: 24, z: 1 });
        toast(t('当前画布已清空', 'This board is cleared'));
      }, [abortRuns, toast, updateGraph]);

      /* ---- 画布管理 ---- */
      const applyStore = useCallback((nextStore) => {
        storeRef.current = nextStore;
        graphRef.current = activeBoardOf(nextStore);
        setStore(nextStore);
      }, []);

      const switchBoard = useCallback(
        (id) => {
          const current = storeRef.current;
          const target = current.boards.find((item) => item.id === id);
          if (!target) return;
          setBoardMenu(false);
          setPendingDelete(null);
          if (current.activeId === id) return;
          abortRuns();
          applyStore({ ...current, activeId: id });
          setSelection([]);
          setLinkEdit(null);
          if (target.nodes.length) window.setTimeout(fitView, 30);
        },
        [abortRuns, applyStore, fitView],
      );

      const createBoard = useCallback(() => {
        const current = storeRef.current;
        const number = current.boardSeq + 1;
        const fresh = emptyBoard(t('画布 ' + number, 'Board ' + number), number);
        abortRuns();
        applyStore({
          ...current,
          boardSeq: number,
          boards: current.boards.concat([fresh]),
          activeId: fresh.id,
        });
        setSelection([]);
        setLinkEdit(null);
        setView({ x: 48, y: 24, z: 1 });
        setPendingDelete(null);
        setRenaming(fresh.id);
        toast(t('已新建画布', 'New board created'));
      }, [abortRuns, applyStore, toast]);

      const renameBoard = useCallback(
        (id, title) => {
          const current = storeRef.current;
          const text = String(title == null ? '' : title).trim().slice(0, 40);
          setRenaming(null);
          if (!text) return;
          if (current.boards.some((item) => item.id === id && item.title === text)) return;
          applyStore({
            ...current,
            boards: current.boards.map((item) => (item.id === id ? { ...item, title: text } : item)),
          });
        },
        [applyStore],
      );

      const deleteBoard = useCallback(
        (id) => {
          const current = storeRef.current;
          const rest = current.boards.filter((item) => item.id !== id);
          abortRuns();
          setSelection([]);
          setLinkEdit(null);
          setPendingDelete(null);
          if (!rest.length) {
            const number = current.boardSeq + 1;
            const fresh = emptyBoard(t('画布 ' + number, 'Board ' + number), number);
            applyStore({ version: 2, activeId: fresh.id, boardSeq: number, boards: [fresh] });
            setView({ x: 48, y: 24, z: 1 });
          } else {
            const wasActive = current.activeId === id;
            applyStore({ ...current, activeId: wasActive ? rest[0].id : current.activeId, boards: rest });
            if (wasActive) setView({ x: 48, y: 24, z: 1 });
          }
          toast(t('画布已删除', 'Board deleted'));
        },
        [abortRuns, applyStore, toast],
      );

      /* ---- 派生 ---- */
      const nodes = board.nodes;
      const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
      const selectedSet = useMemo(() => new Set(selection), [selection]);
      const runningCount = nodes.filter((node) => node.status === 'running').length;

      const edges = useMemo(() => {
        const list = [];
        nodes.forEach((node) => {
          (node.parents || []).forEach((parentId) => {
            const parent = nodeMap.get(parentId);
            if (!parent) return;
            const from = { x: parent.x + CARD_W, y: parent.y + 26 };
            const to = { x: node.x, y: node.y + 26 };
            list.push({
              key: 'parent:' + parent.id + '>' + node.id,
              kind: 'parent',
              from,
              to,
              midX: (from.x + to.x) / 2,
              midY: (from.y + to.y) / 2,
              childId: node.id,
              parentId: parent.id,
              label: (node.relations && node.relations[parent.id]) || '',
              active: selectedSet.has(parent.id) || selectedSet.has(node.id),
            });
          });
        });

        (board.links || []).forEach((link) => {
          const a = nodeMap.get(link.from);
          const b = nodeMap.get(link.to);
          if (!a || !b) return;
          const geometry = linkGeometry(a, b);
          list.push({
            key: 'link:' + link.key,
            kind: 'link',
            from: geometry.from,
            to: geometry.to,
            midX: (geometry.from.x + geometry.to.x) / 2,
            midY: (geometry.from.y + geometry.to.y) / 2,
            linkKey: link.key,
            label: link.label || '',
            active: selectedSet.has(link.from) || selectedSet.has(link.to),
          });
        });

        return list;
      }, [board.links, nodes, nodeMap, selectedSet]);

      const bounds = useMemo(() => {
        let maxX = 600;
        let maxY = 400;
        nodes.forEach((node) => {
          maxX = Math.max(maxX, node.x + CARD_W + 120);
          maxY = Math.max(maxY, node.y + 360);
        });
        return { width: maxX, height: maxY };
      }, [nodes]);

      const selectionHint = useMemo(() => {
        if (mode === 'note') return t('写下的想法会成为一张独立卡片，可以随时修改', 'Your note becomes its own card and stays editable');
        if (!selection.length) return t('新提问会成为画布上的一个起点卡片', 'A new question starts a new root card');
        if (selection.length === 1) {
          const node = nodeMap.get(selection[0]);
          const prefix = node && node.kind === 'note' ? '基于想法「' : '基于「';
          const suffix = node && node.kind === 'note' ? '」提问' : '」继续追问';
          return t(
            prefix + (node ? node.title : '') + suffix,
            'Ask on top of "' + (node ? node.title : '') + '"',
          );
        }
        return t('把选中的 ' + selection.length + ' 张卡片融合成一个新结论', 'Fuse ' + selection.length + ' selected cards into one');
      }, [mode, selection, nodeMap]);

      const placeholder =
        mode === 'note'
          ? t('写下自己的判断、前提或疑问，回车存成一张想法卡片…', 'Write your own judgement, premise or doubt; Enter saves it as a note card…')
          : mode === 'plan'
            ? t('写下要达成的思考目标，编排器会拆成 3–5 步并自动跑完…', 'Describe a goal; the planner splits it into 3–5 steps and runs them…')
            : selection.length >= 2
              ? t('这些卡片一起说明了什么？哪里互相矛盾？', 'What do these cards say together? Where do they conflict?')
              : t('问一个问题，或选中卡片后追问…', 'Ask a question, or select a card and follow up…');

      /* ---- 关系编辑弹层（跟着画布缩放） ---- */
      const dragPreviewNode = linkDrag ? nodeMap.get(linkDrag.fromId) : null;

      const commitEdgeLabel = (value) => {
        if (linkEdit.kind === 'link') saveLink(linkEdit.linkKey, value);
        else saveRelation(linkEdit.childId, linkEdit.parentId, value);
        setLinkEdit(null);
      };

      const linkEditor =
        linkEdit &&
        h(
          'div',
          {
            className: 'fc-rel-edit',
            style: { left: linkEdit.x + 'px', top: linkEdit.y + 'px' },
            onClick: (event) => event.stopPropagation(),
            onPointerDown: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'fc-rel-edit-head' },
            linkEdit.kind === 'link'
              ? t('自定义连线：描述这两张卡片的关系', 'Custom link: describe how these cards relate')
              : t('描述这两张卡片的关系', 'Describe how these cards relate'),
          ),
          h(
            'div',
            { className: 'fc-rel-chips' },
            relationChips().map((chip) =>
              h(
                'button',
                {
                  key: chip,
                  type: 'button',
                  className: 'fc-chip' + (linkEdit.value === chip ? ' is-on' : ''),
                  onClick: () => setLinkEdit({ ...linkEdit, value: chip }),
                },
                chip,
              ),
            ),
          ),
          h('input', {
            className: 'fc-rel-input',
            value: linkEdit.value,
            autoFocus: true,
            maxLength: 60,
            placeholder: t('例如：因此 / 前提是 / 但被反驳', 'e.g. therefore / requires / refuted by'),
            onChange: (event) => setLinkEdit({ ...linkEdit, value: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitEdgeLabel(linkEdit.value);
              } else if (event.key === 'Escape') {
                setLinkEdit(null);
              }
            },
          }),
          h(
            'div',
            { className: 'fc-rel-edit-foot' },
            linkEdit.kind === 'link'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'fc-link is-danger',
                    onClick: () => {
                      removeLink(linkEdit.linkKey);
                      setLinkEdit(null);
                    },
                  },
                  t('删除连线', 'Delete link'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'fc-link is-muted',
                    onClick: () => commitEdgeLabel(''),
                  },
                  t('清除标注', 'Clear label'),
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'fc-chip is-primary',
                onClick: () => commitEdgeLabel(linkEdit.value),
              },
              t('保存', 'Save'),
            ),
          ),
        );

      /* ---- 渲染 ---- */
      const layerStyle = {
        transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.z + ')',
        transformOrigin: '0 0',
      };

      const boardStyle = {
        backgroundPosition: view.x + 'px ' + view.y + 'px',
        backgroundSize: 26 * view.z + 'px ' + 26 * view.z + 'px',
      };

      return h(
        'div',
        { className: 'fc-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),

        h(
          'div',
          { className: 'fc-board', ref: boardRef, onPointerDown: onBoardDown, style: boardStyle },
          h(
            'div',
            { className: 'fc-layer', style: layerStyle },
            h(
              'svg',
              { className: 'fc-edges', width: bounds.width, height: bounds.height, 'aria-hidden': 'true' },
              h(
                'defs',
                null,
                h(
                  'marker',
                  {
                    id: 'fc-arrow',
                    viewBox: '0 0 10 10',
                    refX: 9,
                    refY: 5,
                    markerWidth: 7,
                    markerHeight: 7,
                    orient: 'auto-start-reverse',
                  },
                  h('path', { d: 'M0 1.5 L9 5 L0 8.5 z', className: 'fc-arrow-head' }),
                ),
              ),
              edges.map((edge) => {
                const dx = Math.max(48, Math.abs(edge.to.x - edge.from.x) * 0.45);
                const path =
                  'M ' +
                  edge.from.x +
                  ' ' +
                  edge.from.y +
                  ' C ' +
                  (edge.from.x + dx) +
                  ' ' +
                  edge.from.y +
                  ', ' +
                  (edge.to.x - dx) +
                  ' ' +
                  edge.to.y +
                  ', ' +
                  edge.to.x +
                  ' ' +
                  edge.to.y;
                return h('path', {
                  key: edge.key,
                  d: path,
                  className:
                    'fc-edge' + (edge.kind === 'link' ? ' is-link' : '') + (edge.active ? ' is-active' : ''),
                  markerEnd: edge.kind === 'link' ? undefined : 'url(#fc-arrow)',
                });
              }),
              linkDrag && dragPreviewNode
                ? h('path', {
                    className: 'fc-link-preview',
                    d:
                      'M ' +
                      (dragPreviewNode.x + CARD_W) +
                      ' ' +
                      (dragPreviewNode.y + 26) +
                      ' C ' +
                      (dragPreviewNode.x + CARD_W + 60) +
                      ' ' +
                      (dragPreviewNode.y + 26) +
                      ', ' +
                      (linkDrag.x - 60) +
                      ' ' +
                      linkDrag.y +
                      ', ' +
                      linkDrag.x +
                      ' ' +
                      linkDrag.y,
                  })
                : null,
            ),
            nodes.map((node) =>
              h(NodeCard, {
                key: node.id,
                node,
                selected: selectedSet.has(node.id),
                onSelect: selectNode,
                onDragStart: onDragStart,
                onAction,
                onEditNote: editNote,
              }),
            ),
            /* 每张卡片右缘的连接点：拖到另一张卡片上就建一条自定义连线 */
            nodes.map((node) =>
              h(
                'button',
                {
                  key: 'port-' + node.id,
                  type: 'button',
                  className: 'fc-port' + (selectedSet.has(node.id) ? ' is-on' : ''),
                  style: { left: node.x + CARD_W - 8 + 'px', top: node.y + 18 + 'px' },
                  title: t('拖到另一张卡片上建立连线', 'Drag onto another card to link it'),
                  'data-node': node.id,
                  onPointerDown: (event) => onLinkStart(event, node.id),
                  onClick: (event) => event.stopPropagation(),
                },
                h(Icon, { name: 'link', size: 10 }),
              ),
            ),
            edges.map((edge) =>
              h(
                'button',
                {
                  key: 'rel-' + edge.key,
                  type: 'button',
                  className:
                    'fc-rel' +
                    (edge.kind === 'link' ? ' is-link' : '') +
                    (edge.label ? ' has-label' : '') +
                    (linkEdit &&
                    linkEdit.kind === edge.kind &&
                    (edge.kind === 'link'
                      ? linkEdit.linkKey === edge.linkKey
                      : linkEdit.childId === edge.childId && linkEdit.parentId === edge.parentId)
                      ? ' is-open'
                      : ''),
                  style: { left: edge.midX + 'px', top: edge.midY + 'px' },
                  title:
                    edge.label ||
                    (edge.kind === 'link'
                      ? t('描述这条连线的关系', 'Describe this link')
                      : t('描述这条关系', 'Describe this relation')),
                  onClick: (event) => {
                    event.stopPropagation();
                    setBoardMenu(false);
                    if (edge.kind === 'link') {
                      setLinkEdit({
                        kind: 'link',
                        linkKey: edge.linkKey,
                        value: edge.label,
                        x: edge.midX,
                        y: edge.midY,
                      });
                    } else {
                      setLinkEdit({
                        kind: 'parent',
                        childId: edge.childId,
                        parentId: edge.parentId,
                        value: edge.label,
                        x: edge.midX,
                        y: edge.midY,
                      });
                    }
                  },
                },
                edge.label ? edge.label : h(Icon, { name: 'plus', size: 11 }),
              ),
            ),
            linkEditor,
          ),
          nodes.length === 0
            ? h(
                'div',
                { className: 'fc-empty' },
                h('div', { className: 'fc-empty-mark' }, h(Icon, { name: 'spark', size: 26 })),
                h('h2', null, t('从一个问题开始', 'Start with one question')),
                h(
                  'p',
                  null,
                  t(
                    '每张卡片只回答一个问题。卡片可以追问成链，也可以把右缘的连接点拖到另一张卡片上，自己连一条带说明的关系。',
                    'Each card answers one question. Cards branch into follow-ups — or drag the dot on a card edge onto another card to draw your own labelled link.',
                  ),
                ),
                h(
                  'div',
                  { className: 'fc-samples' },
                  SAMPLE_PROMPTS.map((sample, index) =>
                    h(
                      'button',
                      {
                        key: index,
                        type: 'button',
                        className: 'fc-sample',
                        onClick: () => {
                          setDraft(lang === 'zh' ? sample.zh : sample.en);
                          const element = textareaRef.current;
                          if (element) element.focus();
                        },
                      },
                      h('span', { className: 'fc-sample-tag' }, t(sample.tagZh, sample.tagEn)),
                      t(sample.zh.length > 46 ? sample.zh.slice(0, 46) + '…' : sample.zh, sample.en),
                    ),
                  ),
                ),
              )
            : null,
        ),

        h(
          'header',
          { className: 'fc-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'fc-board-btn' + (boardMenu ? ' is-open' : ''),
              onClick: (event) => {
                event.stopPropagation();
                setLinkEdit(null);
                setBoardMenu((value) => !value);
                setPendingDelete(null);
                setRenaming(null);
              },
              title: t('切换 / 管理画布', 'Switch or manage boards'),
            },
            h('span', { className: 'fc-logo' }, h(Icon, { name: 'board', size: 16 })),
            h(
              'span',
              { className: 'fc-head-text' },
              h('strong', null, board.title),
              h(
                'span',
                null,
                nodes.length
                  ? t(
                      nodes.length + ' 张卡片 · ' + store.boards.length + ' 个画布' + (runningCount ? ' · ' + runningCount + ' 在思考' : ''),
                      nodes.length + ' cards · ' + store.boards.length + ' boards' + (runningCount ? ' · ' + runningCount + ' thinking' : ''),
                    )
                  : t(
                      '空画布 · 共 ' + store.boards.length + ' 个',
                      'Empty · ' + store.boards.length + ' board(s)',
                    ),
              ),
            ),
            h(Icon, { name: 'chevron', size: 14 }),
          ),
          boardMenu
            ? h(
                'div',
                {
                  className: 'fc-menu',
                  onClick: (event) => event.stopPropagation(),
                  onPointerDown: (event) => event.stopPropagation(),
                },
                h(
                  'div',
                  { className: 'fc-menu-head' },
                  h('span', null, t('画布', 'Boards')),
                  h(
                    'button',
                    { type: 'button', className: 'fc-chip is-primary', onClick: createBoard },
                    t('＋ 新建', '＋ New'),
                  ),
                ),
                h(
                  'div',
                  { className: 'fc-menu-list' },
                  store.boards.map((item) =>
                    h(
                      'div',
                      {
                        key: item.id,
                        className: 'fc-menu-row' + (item.id === store.activeId ? ' is-on' : ''),
                      },
                      renaming === item.id
                        ? h('input', {
                            className: 'fc-menu-input',
                            defaultValue: item.title,
                            autoFocus: true,
                            maxLength: 40,
                            onClick: (event) => event.stopPropagation(),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                renameBoard(item.id, event.target.value);
                              } else if (event.key === 'Escape') {
                                setRenaming(null);
                              }
                            },
                            onBlur: (event) => renameBoard(item.id, event.target.value),
                          })
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'fc-menu-name',
                              onClick: () => switchBoard(item.id),
                            },
                            h('span', null, item.title),
                            h('small', null, t(item.nodes.length + ' 张', item.nodes.length + ' cards')),
                          ),
                      pendingDelete === item.id
                        ? h(
                            'span',
                            { className: 'fc-menu-confirm' },
                            h(
                              'button',
                              { type: 'button', className: 'fc-chip is-danger', onClick: () => deleteBoard(item.id) },
                              t('确认删除', 'Delete'),
                            ),
                            h(
                              'button',
                              { type: 'button', className: 'fc-chip', onClick: () => setPendingDelete(null) },
                              t('取消', 'Cancel'),
                            ),
                          )
                        : h(
                            'span',
                            { className: 'fc-menu-acts' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'fc-menu-act',
                                title: t('重命名', 'Rename'),
                                onClick: (event) => {
                                  event.stopPropagation();
                                  setPendingDelete(null);
                                  setRenaming(item.id);
                                },
                              },
                              h(Icon, { name: 'edit', size: 13 }),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'fc-menu-act is-danger',
                                title: t('删除画布', 'Delete board'),
                                onClick: (event) => {
                                  event.stopPropagation();
                                  setRenaming(null);
                                  setPendingDelete(item.id);
                                },
                              },
                              h(Icon, { name: 'trash', size: 13 }),
                            ),
                          ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'fc-menu-note' },
                  t(
                    '每块画布独立保存；切换画布会停止正在生成的卡片。',
                    'Each board is saved on its own; switching stops cards that are still streaming.',
                  ),
                ),
              )
            : null,
        ),

        h(
          'div',
          { className: 'fc-tools' },
          h(
            'button',
            { type: 'button', className: 'fc-tool', onClick: () => zoomCenter(0.85), title: t('缩小', 'Zoom out') },
            h(Icon, { name: 'minus', size: 15 }),
          ),
          h('span', { className: 'fc-zoom' }, Math.round(view.z * 100) + '%'),
          h(
            'button',
            { type: 'button', className: 'fc-tool', onClick: () => zoomCenter(1.18), title: t('放大', 'Zoom in') },
            h(Icon, { name: 'plus', size: 15 }),
          ),
          h('span', { className: 'fc-tools-sep' }),
          h(
            'button',
            { type: 'button', className: 'fc-tool', onClick: fitView, title: t('适应视图', 'Fit to view') },
            h(Icon, { name: 'fit', size: 15 }),
          ),
          h(
            'button',
            { type: 'button', className: 'fc-tool', onClick: autoLayout, title: t('自动布局', 'Auto layout') },
            h(Icon, { name: 'layout', size: 15 }),
          ),
          h('span', { className: 'fc-tools-sep' }),
          h(
            'button',
            { type: 'button', className: 'fc-tool', onClick: () => setHelpOpen(true), title: t('怎么用', 'How it works') },
            h(Icon, { name: 'help', size: 15 }),
          ),
          h(
            'button',
            { type: 'button', className: 'fc-tool is-danger', onClick: clearAll, title: t('清空画布', 'Clear board') },
            h(Icon, { name: 'trash', size: 15 }),
          ),
        ),

        h(
          'div',
          { className: 'fc-dock' },
          h(
            'div',
            { className: 'fc-dock-inner' },
            h(
              'div',
              { className: 'fc-dock-head' },
              h('span', { className: 'fc-dock-hint' }, selectionHint),
              selection.length
                ? h(
                    'button',
                    { type: 'button', className: 'fc-link', onClick: () => setSelection([]) },
                    t('取消选择', 'Clear selection'),
                  )
                : null,
            ),
            h('textarea', {
              ref: textareaRef,
              className: 'fc-input',
              value: draft,
              placeholder,
              rows: 1,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown,
            }),
            h(
              'div',
              { className: 'fc-dock-foot' },
              h(
                'div',
                { className: 'fc-modes', role: 'group' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fc-mode' + (mode === 'ask' ? ' is-on' : ''),
                    onClick: () => setMode('ask'),
                    title: t('一次一张卡片，自己决定下一步', 'One card at a time'),
                  },
                  h(Icon, { name: 'branch', size: 13 }),
                  t('提问', 'Ask'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fc-mode' + (mode === 'plan' ? ' is-on' : ''),
                    onClick: () => setMode('plan'),
                    title: t('自动拆解目标并逐步执行', 'Split a goal and run the steps'),
                  },
                  h(Icon, { name: 'plan', size: 13 }),
                  t('编排', 'Plan'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fc-mode' + (mode === 'note' ? ' is-on' : ''),
                    onClick: () => setMode('note'),
                    title: t('写下自己的思考，不调用模型', 'Write your own thought; no model call'),
                  },
                  h(Icon, { name: 'note', size: 13 }),
                  t('想法', 'Note'),
                ),
              ),
              h(
                'div',
                { className: 'fc-dock-actions' },
                h('span', { className: 'fc-kbd' }, t('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for newline')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fc-send',
                    onClick: submit,
                    disabled: !draft.trim(),
                    title: mode === 'note' ? t('存成想法卡片', 'Save as a note card') : t('发送', 'Send'),
                  },
                  h(Icon, { name: mode === 'plan' ? 'plan' : mode === 'note' ? 'note' : 'send', size: 15 }),
                ),
              ),
            ),
          ),
        ),

        notice ? h('div', { className: 'fc-toast', role: 'status' }, notice) : null,

        helpOpen
          ? h(
              'div',
              { className: 'fc-modal-backdrop', onClick: () => setHelpOpen(false) },
              h(
                'div',
                { className: 'fc-modal', onClick: (event) => event.stopPropagation() },
                h(
                  'div',
                  { className: 'fc-modal-head' },
                  h('strong', null, t('怎么用这张画布', 'How to use the board')),
                  h(
                    'button',
                    { type: 'button', className: 'fc-tool', onClick: () => setHelpOpen(false), title: t('关闭', 'Close') },
                    h(Icon, { name: 'close', size: 15 }),
                  ),
                ),
                h(
                  'ol',
                  { className: 'fc-steps' },
                  h('li', null, t('在下方输入问题回车：生成第一张卡片，模型边想边写。', 'Type a question and press Enter: the first card streams in.')),
                  h('li', null, t('点选一张卡片再提问：新卡片会接在它后面，形成一条思考链。', 'Select a card, then ask: the new card links under it as a chain.')),
                  h('li', null, t('按住 ⌘/Ctrl 点选多张卡片再提问：融合成一个新结论。', '⌘/Ctrl-click several cards, then ask: they fuse into one conclusion.')),
                  h('li', null, t('点两张卡片之间连线上的「＋」：标注这条关系（因为 / 前提是 / 反驳…），标注会一起交给模型。', 'Click the “＋” on a connector to label the relation (because / requires / refutes…); the label also goes to the model.')),
                  h('li', null, t('把卡片右缘的圆点拖到另一张卡片上：自己连一条线（虚线），松手就能写关系说明，也可以随时删除。', 'Drag the dot on a card’s right edge onto another card: you get a dashed link of your own, with a label you can edit or delete.')),
                  h('li', null, t('切到「想法」：写下自己的判断，变成一张可编辑的笔记卡；选中它再提问，就是基于你的思考发问。', 'Switch to Note: your own judgement becomes an editable card; select it and ask to question your own thinking.')),
                  h('li', null, t('切到「编排」写下目标：自动拆成 3–5 步，逐张跑完并连成链路。', 'Switch to Plan with a goal: it splits into 3–5 steps and runs them in a chain.')),
                  h('li', null, t('点左上角的画布名：新建、重命名、切换或删除画布，每块画布独立保存。', 'Click the board name at top-left to create, rename, switch or delete boards; each is saved separately.')),
                  h('li', null, t('拖动卡片标题移动，滚轮平移，⌘/Ctrl+滚轮缩放，右上角可自动布局。', 'Drag a card header to move, scroll to pan, ⌘/Ctrl+scroll to zoom.')),
                ),
                h(
                  'p',
                  { className: 'fc-modal-note' },
                  t(
                    '每张卡片都直接调用当前 Harness 里的模型，没有额外的键或服务。',
                    'Every card calls the model configured in this Harness — no extra key or service.',
                  ),
                ),
              ),
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * 空态示例
     * ------------------------------------------------------------------ */
    const SAMPLE_PROMPTS = [
      {
        tagZh: '拆解',
        tagEn: 'Break down',
        zh: '我想在三个月内把这条产品线做到盈亏平衡，请拆成可验证的假设与关键动作。',
        en: 'I want this product line at break-even in three months. Break it into testable assumptions and key moves.',
      },
      {
        tagZh: '质疑',
        tagEn: 'Stress test',
        zh: '我打算 all in 一个方向：请找出这个判断里最脆弱的一环，以及什么证据会推翻它。',
        en: 'I plan to go all-in on one direction. Find the weakest link and the evidence that would overturn it.',
      },
      {
        tagZh: '决策',
        tagEn: 'Decide',
        zh: '在自建团队和外包之间做选择：列出选项、判据、代价，并给出你倾向的答案。',
        en: 'In-house team vs outsourcing: list the options, criteria, costs, and give your recommended answer.',
      },
    ];

    /* ------------------------------------------------------------------ *
     * 编排结果解析
     * ------------------------------------------------------------------ */
    function parsePlan(rawText) {
      let text = String(rawText || '').trim();
      if (!text) return null;
      const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
      if (fence) text = fence[1].trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      try {
        const value = JSON.parse(text.slice(start, end + 1));
        const steps = Array.isArray(value.steps) ? value.steps : [];
        const cleaned = steps
          .filter((step) => step && (step.prompt || step.title))
          .slice(0, 6)
          .map((step, index) => ({
            title: clip(step.title || t('步骤 ' + (index + 1), 'Step ' + (index + 1)), 22),
            prompt: String(step.prompt || step.title || '').trim(),
          }))
          .filter((step) => step.prompt);
        if (!cleaned.length) return null;
        return { title: typeof value.title === 'string' ? value.title : '', steps: cleaned };
      } catch {
        return null;
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式（只引用宿主主题 token）
     * ------------------------------------------------------------------ */
    const CSS = `
      .fc-page {
        --fc-bg: var(--dsw-alias-bg-base);
        --fc-surface: var(--dsw-alias-bg-layer-1);
        --fc-surface-2: var(--dsw-alias-bg-layer-2);
        --fc-overlay: var(--dsw-alias-bg-overlay);
        --fc-border: var(--dsw-alias-border-l1);
        --fc-border-2: var(--dsw-alias-border-l2);
        --fc-text: var(--dsw-alias-label-primary);
        --fc-text-2: var(--dsw-alias-label-secondary);
        --fc-brand: var(--dsw-alias-brand-primary);
        --fc-error: var(--dsw-alias-state-error-primary);
        --fc-warn: var(--dsw-alias-state-warn-primary);
        --fc-success: var(--dsw-alias-state-success-primary);
        --fc-idle: var(--dsw-alias-state-idle-primary);
        --fc-brand-soft: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
        --fc-error-soft: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
        --fc-hover: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
        --fc-shadow: 0 6px 22px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
        position: relative;
        height: 100%;
        min-height: 520px;
        display: flex;
        background: var(--fc-bg);
        color: var(--fc-text);
        font-size: 13px;
        line-height: 1.55;
        overflow: hidden;
      }
      .fc-page *, .fc-page *::before, .fc-page *::after { box-sizing: border-box; }
      .fc-page button, .fc-page textarea { font: inherit; color: inherit; }
      .fc-page button { cursor: pointer; }
      .fc-icon { display: block; flex: none; }

      /* ---------------- 画布 ---------------- */
      .fc-board {
        position: relative; flex: 1; min-width: 0; overflow: hidden;
        cursor: grab; touch-action: none;
        background-color: var(--fc-bg);
        background-image: radial-gradient(
          color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent) 1px,
          transparent 1px
        );
        background-repeat: repeat;
      }
      .fc-board:active { cursor: grabbing; }
      .fc-layer { position: absolute; left: 0; top: 0; will-change: transform; }
      .fc-edges { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
      .fc-edge {
        fill: none;
        stroke: var(--fc-border-2);
        stroke-width: 1.4;
        opacity: 0.9;
      }
      .fc-edge.is-active { stroke: var(--fc-brand); stroke-width: 1.8; }
      .fc-edge.is-link { stroke-dasharray: 5 5; stroke-width: 1.3; opacity: .7; }
      .fc-edge.is-link.is-active { opacity: 1; }
      .fc-link-preview {
        fill: none; stroke: var(--fc-brand); stroke-width: 1.6;
        stroke-dasharray: 6 5; opacity: .85; pointer-events: none;
      }
      .fc-arrow-head { fill: var(--fc-border-2); }
      .fc-edge.is-active + .fc-arrow-head { fill: var(--fc-brand); }

      /* ---------------- 卡片 ---------------- */
      .fc-card {
        position: absolute;
        display: flex; flex-direction: column;
        background: var(--fc-surface);
        border: 1px solid var(--fc-border);
        border-radius: 13px;
        box-shadow: var(--fc-shadow);
        overflow: hidden;
        transition: border-color .15s ease, box-shadow .15s ease;
        user-select: text;
      }
      .fc-card:hover { border-color: var(--fc-border-2); }
      .fc-card.is-selected {
        border-color: var(--fc-brand);
        box-shadow: 0 0 0 1px var(--fc-brand), var(--fc-shadow);
      }
      .fc-card.is-running { border-color: color-mix(in srgb, var(--fc-brand) 55%, var(--fc-border)); }
      .fc-card.is-error { border-color: color-mix(in srgb, var(--fc-error) 55%, var(--fc-border)); }

      .fc-card-head {
        display: flex; align-items: center; gap: 7px;
        padding: 9px 11px 7px;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .fc-card-head:active { cursor: grabbing; }
      .fc-dot {
        width: 7px; height: 7px; border-radius: 50%; flex: none;
        background: var(--fc-idle);
      }
      .fc-dot.is-running {
        background: var(--fc-brand);
        animation: fc-pulse 1.1s ease-in-out infinite;
      }
      .fc-dot.is-done { background: var(--fc-success); }
      .fc-dot.is-error { background: var(--fc-error); }
      .fc-card-title {
        flex: 1; min-width: 0;
        font-size: 12.5px; font-weight: 600; letter-spacing: .01em;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .fc-kind {
        flex: none; font-size: 10px; line-height: 1; padding: 3px 6px;
        border-radius: 5px; color: var(--fc-text-2);
        background: var(--fc-surface-2); border: 1px solid var(--fc-border);
      }
      .fc-kind.is-fuse { color: var(--fc-brand); border-color: color-mix(in srgb, var(--fc-brand) 40%, transparent); }
      .fc-kind.is-plan { color: var(--fc-warn); border-color: color-mix(in srgb, var(--fc-warn) 40%, transparent); }
      .fc-check {
        flex: none; width: 16px; height: 16px; border-radius: 50%;
        display: grid; place-items: center;
        color: var(--fc-bg); background: var(--fc-brand);
      }

      .fc-card-q {
        margin: 0 11px 2px;
        font-size: 11.5px; color: var(--fc-text-2);
        border-left: 2px solid var(--fc-border-2);
        padding-left: 8px;
        max-height: 54px; overflow: hidden;
      }
      .fc-card-body {
        padding: 7px 11px 10px;
        max-height: 224px; overflow-y: auto; overflow-x: hidden;
        font-size: 12.5px;
        scrollbar-width: thin;
      }
      .fc-card-body > *:first-child { margin-top: 0; }
      .fc-card-body p { margin: 0 0 6px; }
      .fc-card-body ul, .fc-card-body ol { margin: 0 0 6px; padding-left: 17px; }
      .fc-card-body li { margin: 1px 0; }
      .fc-card-body .fc-h {
        margin: 8px 0 3px; font-size: 11.5px; font-weight: 600;
        color: var(--fc-text-2); letter-spacing: .03em;
      }
      .fc-card-body code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px; padding: 1px 4px; border-radius: 4px;
        background: var(--fc-surface-2); border: 1px solid var(--fc-border);
      }
      .fc-card-body strong { font-weight: 600; }
      .fc-card-body.is-note { padding: 2px 9px 8px; max-height: none; }
      .fc-card.is-note { border-color: color-mix(in srgb, var(--fc-warn) 34%, var(--fc-border)); }
      .fc-card.is-note.is-selected { border-color: var(--fc-brand); }
      .fc-dot.is-note { background: var(--fc-warn); }
      .fc-kind.is-note { color: var(--fc-warn); border-color: color-mix(in srgb, var(--fc-warn) 42%, transparent); }
      .fc-note-input {
        width: 100%; min-height: 56px; max-height: 260px; resize: none;
        border: 0; outline: 0; background: transparent; color: var(--fc-text);
        font-size: 12.5px; line-height: 1.55; overflow-y: auto;
      }
      .fc-note-input::placeholder { color: var(--fc-text-2); opacity: .75; }
      .fc-muted { color: var(--fc-text-2); font-size: 11.5px; }
      .fc-think {
        margin-top: 6px; padding: 6px 8px; border-radius: 7px;
        font-size: 11px; color: var(--fc-text-2);
        background: var(--fc-surface-2);
        border-left: 2px solid var(--fc-border-2);
        max-height: 92px; overflow: hidden;
      }
      .fc-caret {
        display: inline-block; width: 5px; height: 12px; margin-left: 2px;
        background: var(--fc-brand); vertical-align: -1px;
        animation: fc-blink 1s steps(2) infinite;
      }
      .fc-card-error {
        margin: 0 11px 8px; padding: 6px 8px; border-radius: 7px;
        font-size: 11px; color: var(--fc-error); background: var(--fc-error-soft);
      }
      .fc-card-foot {
        display: flex; align-items: center; gap: 2px;
        padding: 4px 7px 6px; border-top: 1px solid var(--fc-border);
        opacity: .55; transition: opacity .15s ease;
      }
      .fc-card:hover .fc-card-foot { opacity: 1; }
      .fc-mini {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 6px; border-radius: 6px; border: 1px solid transparent;
        background: transparent; color: var(--fc-text-2); font-size: 11px;
      }
      .fc-mini:hover { background: var(--fc-hover); color: var(--fc-text); border-color: var(--fc-border); }
      .fc-mini.is-danger { margin-left: auto; }
      .fc-mini.is-danger:hover { color: var(--fc-error); border-color: color-mix(in srgb, var(--fc-error) 40%, transparent); }

      /* ---------------- 空态 ---------------- */
      .fc-empty {
        position: absolute; inset: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; padding: 24px; text-align: center; pointer-events: none;
      }
      .fc-empty-mark {
        width: 46px; height: 46px; border-radius: 13px;
        display: grid; place-items: center; color: var(--fc-brand);
        background: var(--fc-brand-soft);
        border: 1px solid color-mix(in srgb, var(--fc-brand) 24%, transparent);
        margin-bottom: 2px;
      }
      .fc-empty h2 { margin: 0; font-size: 16px; font-weight: 600; }
      .fc-empty p { margin: 0; max-width: 440px; font-size: 12px; color: var(--fc-text-2); }
      .fc-samples { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 10px; pointer-events: auto; }
      .fc-sample {
        max-width: 230px; text-align: left;
        display: flex; flex-direction: column; gap: 3px;
        padding: 9px 11px; border-radius: 10px;
        background: var(--fc-surface); border: 1px solid var(--fc-border);
        color: var(--fc-text-2); font-size: 11.5px; line-height: 1.45;
      }
      .fc-sample:hover { border-color: var(--fc-brand); color: var(--fc-text); }
      .fc-sample-tag { font-size: 10px; color: var(--fc-brand); font-weight: 600; }

      /* ---------------- 顶部：画布切换 ---------------- */
      .fc-head {
        position: absolute; left: 16px; top: 14px;
        display: flex; align-items: flex-start;
        z-index: 24;
      }
      .fc-board-btn {
        display: flex; align-items: center; gap: 9px;
        padding: 8px 11px 8px 10px; border-radius: 11px;
        background: var(--fc-surface); border: 1px solid var(--fc-border);
        box-shadow: var(--fc-shadow); color: var(--fc-text);
        text-align: left; max-width: 320px;
      }
      .fc-board-btn:hover { border-color: var(--fc-border-2); }
      .fc-board-btn.is-open { border-color: var(--fc-brand); }
      .fc-board-btn > .fc-icon:last-child { color: var(--fc-text-2); flex: none; }
      .fc-board-btn .fc-head-text { min-width: 0; }
      .fc-board-btn .fc-head-text strong {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .fc-logo {
        width: 26px; height: 26px; border-radius: 8px; flex: none;
        display: grid; place-items: center; color: var(--fc-brand);
        background: var(--fc-brand-soft);
        border: 1px solid color-mix(in srgb, var(--fc-brand) 22%, transparent);
      }
      .fc-head-text { display: flex; flex-direction: column; line-height: 1.25; }
      .fc-head-text strong { font-size: 12.5px; font-weight: 600; }
      .fc-head-text span {
        font-size: 10.5px; color: var(--fc-text-2);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      .fc-menu {
        position: absolute; left: 0; top: 46px; width: 296px;
        max-height: min(420px, 62vh);
        display: flex; flex-direction: column;
        padding: 10px; border-radius: 12px;
        background: var(--fc-overlay); border: 1px solid var(--fc-border-2);
        box-shadow: var(--fc-shadow); z-index: 26;
      }
      .fc-menu-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 2px 8px; font-size: 11px; color: var(--fc-text-2);
      }
      .fc-menu-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
      .fc-menu-row {
        display: flex; align-items: center; gap: 4px;
        padding: 4px 6px; border-radius: 8px;
      }
      .fc-menu-row:hover { background: var(--fc-hover); }
      .fc-menu-row.is-on { background: var(--fc-brand-soft); }
      .fc-menu-name {
        flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px;
        background: none; border: 0; padding: 2px 0; text-align: left;
      }
      .fc-menu-name span {
        flex: 1; min-width: 0; font-size: 12px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .fc-menu-name small { flex: none; font-size: 10px; color: var(--fc-text-2); }
      .fc-menu-input {
        flex: 1; min-width: 0; padding: 4px 6px; border-radius: 6px;
        border: 1px solid var(--fc-brand); background: var(--fc-surface);
        color: var(--fc-text); font-size: 12px; outline: none;
      }
      .fc-menu-acts { display: flex; gap: 2px; flex: none; }
      .fc-menu-act {
        width: 24px; height: 24px; border-radius: 6px;
        display: grid; place-items: center;
        background: transparent; border: 1px solid transparent; color: var(--fc-text-2);
      }
      .fc-menu-act:hover { background: var(--fc-hover); color: var(--fc-text); }
      .fc-menu-act.is-danger:hover { color: var(--fc-error); }
      .fc-menu-confirm { display: flex; gap: 4px; flex: none; }
      .fc-menu-note {
        margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--fc-border);
        font-size: 10px; color: var(--fc-text-2); line-height: 1.4;
      }

      .fc-chip {
        padding: 3px 8px; border-radius: 6px; font-size: 11px; line-height: 1.4;
        border: 1px solid var(--fc-border); background: var(--fc-surface);
        color: var(--fc-text-2); white-space: nowrap;
      }
      .fc-chip:hover { color: var(--fc-text); border-color: var(--fc-border-2); }
      .fc-chip.is-on { color: var(--fc-brand); border-color: var(--fc-brand); background: var(--fc-brand-soft); }
      .fc-chip.is-primary {
        color: var(--fc-bg); background: var(--fc-brand); border-color: var(--fc-brand);
        font-weight: 600; padding: 4px 9px;
      }
      .fc-chip.is-primary:hover { filter: brightness(1.06); color: var(--fc-bg); }
      .fc-chip.is-danger { color: var(--fc-error); border-color: color-mix(in srgb, var(--fc-error) 45%, transparent); }
      .fc-link.is-muted { color: var(--fc-text-2); }
      .fc-link.is-danger { color: var(--fc-error); }

      /* ---------------- 关系标注 ---------------- */
      .fc-rel {
        position: absolute; transform: translate(-50%, -50%);
        display: inline-block; max-width: 96px;
        padding: 2px 7px; border-radius: 999px;
        font-size: 10px; line-height: 1.45; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; text-align: center;
        background: var(--fc-surface); border: 1px dashed var(--fc-border-2);
        color: var(--fc-text-2); opacity: .4;
        transition: opacity .12s ease, border-color .12s ease, color .12s ease;
      }
      .fc-rel .fc-icon { display: inline-block; vertical-align: -2px; }
      .fc-rel:hover { opacity: 1; border-color: var(--fc-brand); color: var(--fc-brand); }
      .fc-rel.has-label {
        opacity: .95; border-style: solid;
        background: var(--fc-surface-2); color: var(--fc-text);
      }
      .fc-rel.is-open { opacity: 1; border-color: var(--fc-brand); color: var(--fc-brand); }
      .fc-rel.is-link { border-color: color-mix(in srgb, var(--fc-brand) 45%, var(--fc-border-2)); }
      .fc-rel.is-link.has-label { background: var(--fc-brand-soft); }

      /* ---------------- 连线端口 ---------------- */
      .fc-port {
        position: absolute; z-index: 3;
        width: 16px; height: 16px; border-radius: 50%;
        display: grid; place-items: center;
        background: var(--fc-surface); border: 1px solid var(--fc-border-2);
        color: var(--fc-text-2); opacity: .3; cursor: crosshair;
        touch-action: none; user-select: none;
        transition: opacity .12s ease, border-color .12s ease, color .12s ease, transform .12s ease;
      }
      .fc-port:hover {
        opacity: 1; transform: scale(1.15);
        border-color: var(--fc-brand); color: var(--fc-brand); background: var(--fc-brand-soft);
      }
      .fc-port.is-on {
        opacity: 1; color: var(--fc-brand);
        border-color: color-mix(in srgb, var(--fc-brand) 60%, transparent);
      }

      .fc-rel-edit {
        position: absolute; z-index: 26; width: 252px;
        transform: translate(-50%, 8px);
        display: flex; flex-direction: column; gap: 7px;
        padding: 10px; border-radius: 11px;
        background: var(--fc-overlay); border: 1px solid var(--fc-border-2);
        box-shadow: var(--fc-shadow);
      }
      .fc-rel-edit-head { font-size: 11px; color: var(--fc-text-2); }
      .fc-rel-chips { display: flex; flex-wrap: wrap; gap: 4px; }
      .fc-rel-input {
        width: 100%; padding: 6px 8px; border-radius: 7px;
        border: 1px solid var(--fc-border); background: var(--fc-surface);
        color: var(--fc-text); font-size: 12px; outline: none;
      }
      .fc-rel-input:focus { border-color: var(--fc-brand); }
      .fc-rel-edit-foot { display: flex; align-items: center; justify-content: space-between; }

      .fc-tools {
        position: absolute; right: 16px; top: 14px;
        display: flex; align-items: center; gap: 2px;
        padding: 4px; border-radius: 11px;
        background: var(--fc-surface); border: 1px solid var(--fc-border);
        box-shadow: var(--fc-shadow);
      }
      .fc-tool {
        width: 28px; height: 28px; border-radius: 7px;
        display: grid; place-items: center;
        background: transparent; border: 1px solid transparent; color: var(--fc-text-2);
      }
      .fc-tool:hover { background: var(--fc-hover); color: var(--fc-text); }
      .fc-tool.is-danger:hover { color: var(--fc-error); }
      .fc-zoom {
        font-size: 10.5px; color: var(--fc-text-2);
        min-width: 34px; text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .fc-tools-sep { width: 1px; height: 16px; margin: 0 3px; background: var(--fc-border); }

      /* ---------------- 输入坞 ---------------- */
      .fc-dock {
        position: absolute; left: 50%; bottom: 18px;
        width: min(680px, calc(100% - 32px));
        transform: translateX(-50%);
      }
      .fc-dock-inner {
        display: flex; flex-direction: column; gap: 6px;
        padding: 10px 12px 9px; border-radius: 14px;
        background: var(--fc-surface); border: 1px solid var(--fc-border-2);
        box-shadow: 0 10px 30px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
      }
      .fc-dock-inner:focus-within { border-color: color-mix(in srgb, var(--fc-brand) 55%, var(--fc-border)); }
      .fc-dock-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .fc-dock-hint { font-size: 10.5px; color: var(--fc-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fc-link { background: none; border: 0; padding: 0; font-size: 10.5px; color: var(--fc-brand); }
      .fc-link:hover { text-decoration: underline; }
      .fc-input {
        width: 100%; resize: none; border: 0; outline: 0;
        background: transparent; color: var(--fc-text);
        font-size: 13px; line-height: 1.5;
        max-height: 168px; overflow-y: auto;
      }
      .fc-input::placeholder { color: var(--fc-text-2); opacity: .8; }
      .fc-dock-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .fc-modes { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--fc-surface-2); }
      .fc-mode {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 4px 8px; border-radius: 6px;
        background: transparent; border: 1px solid transparent;
        color: var(--fc-text-2); font-size: 11px;
      }
      .fc-mode:hover { color: var(--fc-text); }
      .fc-mode.is-on {
        background: var(--fc-surface); color: var(--fc-text);
        border-color: var(--fc-border); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
      }
      .fc-dock-actions { display: flex; align-items: center; gap: 8px; }
      .fc-kbd { font-size: 10px; color: var(--fc-text-2); opacity: .75; }
      .fc-send {
        width: 30px; height: 30px; border-radius: 9px;
        display: grid; place-items: center;
        background: var(--fc-brand); border: 1px solid transparent; color: var(--fc-bg);
      }
      .fc-send:disabled { opacity: .4; cursor: default; }
      .fc-send:not(:disabled):hover { filter: brightness(1.06); }

      .fc-toast {
        position: absolute; left: 50%; bottom: 132px; transform: translateX(-50%);
        padding: 6px 12px; border-radius: 8px; font-size: 11.5px;
        background: var(--fc-text); color: var(--fc-bg);
        box-shadow: var(--fc-shadow); z-index: 20;
      }

      /* ---------------- 帮助 ---------------- */
      .fc-modal-backdrop {
        position: absolute; inset: 0; z-index: 30;
        display: grid; place-items: center;
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
      }
      .fc-modal {
        width: min(520px, calc(100% - 40px));
        max-height: calc(100% - 60px); overflow-y: auto;
        padding: 16px 18px 14px; border-radius: 14px;
        background: var(--fc-overlay); border: 1px solid var(--fc-border-2);
        box-shadow: var(--fc-shadow);
      }
      .fc-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .fc-modal-head strong { font-size: 13.5px; }
      .fc-steps { margin: 0; padding-left: 18px; font-size: 12px; color: var(--fc-text); }
      .fc-steps li { margin: 5px 0; color: var(--fc-text-2); }
      .fc-steps li::marker { color: var(--fc-brand); }
      .fc-modal-note {
        margin: 12px 0 0; padding-top: 10px; font-size: 11px; color: var(--fc-text-2);
        border-top: 1px solid var(--fc-border);
      }

      @keyframes fc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      @keyframes fc-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

      @media (max-width: 760px) {
        .fc-head { left: 10px; top: 10px; }
        .fc-board-btn { padding: 6px 9px 6px 7px; max-width: 200px; }
        .fc-head-text span { display: none; }
        .fc-tools { right: 10px; top: 10px; }
        .fc-zoom, .fc-tools-sep { display: none; }
        .fc-dock { bottom: 10px; width: calc(100% - 20px); }
        .fc-kbd { display: none; }
        .fc-samples { display: none; }
        .fc-menu { width: min(296px, calc(100vw - 28px)); }
      }
    `;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale;
        syncLang();
        ctx.effect(() => {
          const dispose = localeService.subscribe(() => {
            syncLang();
          });
          return () => {
            if (typeof dispose === 'function') dispose();
          };
        }, 'flowith-locale');

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'flowith',
              order: 21,
              label: () => t('思维画布', 'Thinking canvas'),
            },
            function PanelIcon(props) {
              const size = props && props.size ? props.size : 20;
              return h(
                'svg',
                {
                  width: size,
                  height: size,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.6,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': 'true',
                  style: { display: 'block' },
                },
                h('circle', { cx: 5.5, cy: 12, r: 2.3 }),
                h('circle', { cx: 18.5, cy: 7, r: 2.3 }),
                h('circle', { cx: 18.5, cy: 17, r: 2.3 }),
                h('path', { d: 'M7.8 12c3 0 3.2-4.2 8.4-4.9' }),
                h('path', { d: 'M7.8 12c3 0 3.2 4.2 8.4 4.9' }),
              );
            },
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'flowith' }, FlowithPage),
        );
      },
    };
  },
});
