/**
 * dsh-paste-packer — browser half.
 *
 * What it does
 * ------------
 * A paste of more than 20 lines is packed instead of dumped into the composer:
 * the plugin swallows the paste, stores the text, and inserts a *reference
 * chip* into the shell's editor whose clipboard form is `[已粘贴文本 #1 · 23 行]`.
 * A card for every packed chip renders in `conversation.input.dock`, right
 * above the composer card.
 *
 * Why a chip and not plain text
 * -----------------------------
 * The shell owns the Lexical editor and exposes no before-submit hook, so a
 * plain-text placeholder can never be turned back into the original on send.
 * The one official expansion point is a trigger source's
 * `codec.serialize(ref)`, which the submit path calls per chip occurrence
 * (`InputState.occurrences` -> splice -> default sink). The chip is therefore
 * the only representation that survives to send time, and `serialize` is what
 * makes the model receive the full text while the composer stays short.
 *
 * Documented couplings to host internals (all guarded, all fail soft)
 * ------------------------------------------------------------------
 * 1. `[data-composer-input]` — the shell's contenteditable, used only to scope
 *    the paste interception to the right composer.
 * 2. `slash/input-insert-reference` — the scoped bail event that inserts a
 *    chip; `ctx.conversation.input.for(actx).insertReference()` is the
 *    service-face fallback.
 * 3. `ctx.inputTriggers.registerSource` — owns the codec, so the plugin stays
 *    installed as a bundle (dynamic client plugins have no `bail`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-paste-packer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SOURCE = 'paste-packer';
    const NS = 'dsh-paste-packer';
    const STORAGE_KEY = 'dsh-paste-packer.v1';
    /** Pack strictly above this many lines. */
    const PACK_ABOVE_LINES = 20;
    /**
     * Preview ceiling for the expanded body. Same value as the shipped dock
     * bar's expanded list (`.aSus8q_list`).
     *
     * The card keeps ONE width in both states — the dock-width formula below,
     * which lands on the composer card's own width — because the request is an
     * in-place preview, not a wider one. Widening only the open state also made
     * the card jump sideways whenever its max-width cap bit.
     */
    const PREVIEW_MAX_HEIGHT = 180;
    const MAX_STORED_ITEMS = 24;
    const MAX_STORED_CHARS = 1500000;
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]';
    const EMPTY_OCCURRENCES = Object.freeze([]);
    const NO_REFS = Object.freeze(new Set());

    const MONO_FONT =
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

    // ------------------------------------------------------------------ text

    const DICTS = {
      en: {
        label: '[Pasted text #{n} \u00b7 {lines} lines]',
        labelBare: '[Pasted text #{n}]',
        preview: 'Preview',
        previewHide: 'Hide preview',
        expand: 'Expand',
        remove: 'Remove',
        missing: 'Original text unavailable \u2014 this paste was inserted before a page reload.',
        empty: '(empty)',
      },
      zh: {
        label: '[已粘贴文本 #{n} \u00b7 {lines} 行]',
        labelBare: '[已粘贴文本 #{n}]',
        preview: '预览',
        previewHide: '收起预览',
        expand: '展开',
        remove: '删除',
        missing: '原文不可用 —— 这段粘贴是在页面刷新前插入的。',
        empty: '（空内容）',
      },
    };

    let translate = null;

    function format(template, vars) {
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
      );
    }

    function t(key, vars) {
      let text = null;
      if (translate !== null) {
        try {
          const value = translate(key);
          if (typeof value === 'string' && value !== key) text = value;
        } catch (error) {
          text = null;
        }
      }
      if (text === null) text = DICTS.zh[key];
      if (typeof text !== 'string') text = key;
      return vars ? format(text, vars) : text;
    }

    /**
     * Line count of a pasted block. One trailing newline is a paste artifact,
     * not an extra line, so it is not counted.
     */
    function countLines(text) {
      if (typeof text !== 'string' || text === '') return 0;
      let normalized = text.replace(/\r\n?/g, '\n');
      if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1);
      if (normalized === '') return 1;
      return normalized.split('\n').length;
    }

    // ----------------------------------------------------------------- store

    /** ref -> { ref, seq, lines, text } */
    const items = new Map();
    let counter = 0;

    /**
     * The insert-time label is cached on the item on purpose: it is also the
     * chip's clipboard projection, and a projection that changed length later
     * (a locale switch, a lost line count) would move every occurrence offset.
     */
    function labelFor(item) {
      if (typeof item.label === 'string' && item.label !== '') return item.label;
      return t('label', { n: item.seq, lines: item.lines });
    }

    function labelBare(seq) {
      return t('labelBare', { n: seq });
    }

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && typeof data.counter === 'number' && isFinite(data.counter)) {
          counter = Math.max(0, Math.floor(data.counter));
        }
        if (data && Array.isArray(data.items)) {
          for (const entry of data.items) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const value = entry[1];
            if (!value || typeof value.text !== 'string') continue;
            const ref = String(entry[0]);
            const seq = typeof value.seq === 'number' && isFinite(value.seq) ? value.seq : Number(ref) || 0;
            const lines = typeof value.lines === 'number' && isFinite(value.lines) ? value.lines : countLines(value.text);
            const label = typeof value.label === 'string' && value.label !== '' ? value.label : null;
            items.set(ref, { ref, seq, lines, text: value.text, label });
            if (seq > counter) counter = seq;
          }
        }
      } catch (error) {
        // Storage unavailable or corrupt: keep the in-memory store only.
      }
    }

    function saveStore() {
      try {
        let kept = [...items.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_STORED_ITEMS);
        while (kept.length > 0) {
          const raw = JSON.stringify({
            counter,
            items: kept.map((item) => [item.ref, { seq: item.seq, lines: item.lines, label: item.label, text: item.text }]),
          });
          if (raw.length <= MAX_STORED_CHARS) {
            window.localStorage.setItem(STORAGE_KEY, raw);
            return;
          }
          kept = kept.slice(1);
        }
        window.localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        // Quota or disabled storage: the session keeps working, only the
        // ability to restore an old chip after a reload is lost.
      }
    }

    // ---------------------------------------------------- composer discovery

    /** @type {{ ctx: unknown, conversation: unknown, sessions: unknown, sourceReady: boolean }} */
    const runtime = { ctx: null, conversation: null, sessions: null, sourceReady: false };

    /** Mounted dock entries, so one document listener can address the right composer. */
    const composers = new Set();

    function resolveComposerInput(root) {
      let node = root;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        if (typeof node.querySelector === 'function') {
          const found = node.querySelector(COMPOSER_INPUT_SELECTOR);
          if (found) return found;
        }
        node = node.parentElement;
      }
      return null;
    }

    function findComposer(target) {
      for (const entry of composers) {
        const input = entry.inputElement();
        if (!input) continue;
        if (input === target || input.contains(target)) return entry;
      }
      return null;
    }

    // ------------------------------------------------------ paste interception

    function handlePaste(event) {
      try {
        if (!event || event.defaultPrevented) return;
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        const entry = findComposer(target);
        if (!entry) return;

        // File and image pastes belong to the shipped handler (path intake).
        const clipboardItems = clipboardData.items;
        if (clipboardItems) {
          for (let index = 0; index < clipboardItems.length; index += 1) {
            const clipboardItem = clipboardItems[index];
            if (clipboardItem && clipboardItem.kind === 'file') return;
          }
        }

        let text = '';
        try {
          text = clipboardData.getData('text/plain') || '';
        } catch (error) {
          return;
        }
        if (!text) return;

        const lines = countLines(text);
        if (lines <= PACK_ABOVE_LINES) return;

        const actions = entry.actions();
        if (!actions || typeof actions.captureInsertion !== 'function') return;

        // Ours from here on: the shipped handler must not also paste the text.
        event.preventDefault();
        event.stopPropagation();
        pack(entry, text, lines);
      } catch (error) {
        console.warn('[dsh-paste-packer] paste interception failed', error);
      }
    }

    function pack(entry, text, lines) {
      const actions = entry.actions();
      // Without a registered codec there is no expansion point on send, so a
      // chip here would be sent as its placeholder. Paste normally instead.
      if (!runtime.sourceReady) {
        insertPlain(actions, text);
        return;
      }

      counter += 1;
      const ref = String(counter);
      const label = t('label', { n: counter, lines });
      const item = { ref, seq: counter, lines, text, label };
      items.set(ref, item);
      saveStore();

      const reference = {
        source: SOURCE,
        ref,
        label,
        appearance: 'file',
        clipboardText: label,
      };

      let span = null;
      try {
        span = actions.captureInsertion();
      } catch (error) {
        span = null;
      }
      if (span && typeof span.draftRev === 'number' && insertChip(entry, reference, span)) return;

      // Degrade to a plain paste rather than dropping what the user pasted.
      console.warn('[dsh-paste-packer] could not insert a packing chip; pasting the text unchanged.');
      insertPlain(actions, text);
    }

    function insertChip(entry, reference, span) {
      const actx = entry.actx();
      if (actx && typeof actx.bail === 'function') {
        try {
          if (actx.bail(actx, 'slash/input-insert-reference', { reference, span }) === true) return true;
        } catch (error) {
          // Fall through to the service face.
        }
      }
      const conversation = runtime.conversation;
      if (actx && conversation && conversation.input && typeof conversation.input.for === 'function') {
        try {
          const sessionInput = conversation.input.for(actx);
          if (sessionInput && typeof sessionInput.insertReference === 'function') {
            if (sessionInput.insertReference(reference, span) === true) return true;
          }
        } catch (error) {
          // Give up on the chip.
        }
      }
      return false;
    }

    function insertPlain(actions, text) {
      try {
        return actions.insertText(text, actions.captureInsertion()) === true;
      } catch (error) {
        return false;
      }
    }

    /**
     * Replace one chip occurrence with `text`, in one undoable editor edit.
     *
     * The span is rebuilt from the *live* revision read off
     * `captureInsertion()` because the render-time revision can be stale. The
     * `setDraft` fallback rewrites the whole draft and therefore drops any
     * other reference chip in it — a last resort only.
     */
    function replaceOccurrence(actions, occurrence, text, fallbackDraft) {
      let revision = null;
      try {
        const live = actions.captureInsertion();
        if (live && typeof live.draftRev === 'number') revision = live.draftRev;
      } catch (error) {
        revision = null;
      }
      if (revision !== null) {
        const span = {
          start: occurrence.offset,
          end: occurrence.offset + occurrence.length,
          draftRev: revision,
        };
        try {
          if (actions.insertText(text, span) === true) return true;
        } catch (error) {
          // Fall through to the draft rewrite.
        }
      }
      if (typeof fallbackDraft !== 'string' || typeof actions.setDraft !== 'function') return false;
      try {
        actions.setDraft(
          fallbackDraft.slice(0, occurrence.offset) + text + fallbackDraft.slice(occurrence.offset + occurrence.length),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    // ------------------------------------------------------- markdown render

    const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]\n]*\]\([^)\s]+\))/g;

    const INLINE_CODE_STYLE = {
      fontFamily: MONO_FONT,
      fontSize: '0.94em',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))',
      borderRadius: 4,
      padding: '0 3px',
    };

    const LINK_STYLE = {
      color: 'var(--dsw-alias-link, var(--dsw-alias-brand-primary, #4d8dff))',
      textDecoration: 'underline',
    };

    function renderInline(text, keyPrefix) {
      const nodes = [];
      let last = 0;
      let index = 0;
      INLINE_PATTERN.lastIndex = 0;
      let match = INLINE_PATTERN.exec(text);
      while (match !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = keyPrefix + ':' + index;
        index += 1;
        if (token.charAt(0) === '`') {
          nodes.push(h('code', { key, style: INLINE_CODE_STYLE }, token.slice(1, -1)));
        } else if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(h('strong', { key, style: { fontWeight: 650 } }, token.slice(2, -2)));
        } else if (token.startsWith('~~')) {
          nodes.push(h('span', { key, style: { textDecoration: 'line-through', opacity: 0.72 } }, token.slice(2, -2)));
        } else if (token.charAt(0) === '*') {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else {
          const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
          if (link) {
            nodes.push(
              h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener', style: LINK_STYLE }, link[1] || link[2]),
            );
          } else {
            nodes.push(token);
          }
        }
        last = match.index + token.length;
        match = INLINE_PATTERN.exec(text);
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    function isBlockStart(line) {
      return (
        /^\s*$/.test(line) ||
        /^\s*(```|~~~)/.test(line) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
        /^#{1,6}\s+/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*[-*+]\s+/.test(line) ||
        /^\s*\d+[.)]\s+/.test(line)
      );
    }

    function headingStyle(level) {
      const size = level <= 1 ? 15.5 : level === 2 ? 14.5 : 13.5;
      return { margin: '2px 0 6px', fontFamily: MONO_FONT, fontSize: size, fontWeight: 700, lineHeight: 1.4 };
    }

    /**
     * Minimal, dependency-free Markdown subset: fenced code, headings, quote,
     * ordered/unordered lists, rules, and inline code/bold/italic/strike/link.
     * Unmatched text stays verbatim, so a preview never loses content.
     */
    function renderMarkdown(source) {
      const lines = String(source === undefined || source === null ? '' : source)
        .replace(/\r\n?/g, '\n')
        .split('\n');
      const blocks = [];
      let cursor = 0;
      let seed = 0;

      while (cursor < lines.length) {
        const line = lines[cursor];
        const fence = /^\s*(```|~~~)/.exec(line);

        if (fence) {
          const body = [];
          cursor += 1;
          while (cursor < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[cursor])) {
            body.push(lines[cursor]);
            cursor += 1;
          }
          if (cursor < lines.length) cursor += 1;
          blocks.push(
            h(
              'pre',
              {
                key: 'b' + seed,
                style: {
                  margin: '2px 0 8px',
                  padding: '7px 9px',
                  background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
                  borderRadius: 8,
                  overflowX: 'auto',
                  whiteSpace: 'pre',
                },
              },
              h('code', null, body.join('\n')),
            ),
          );
          seed += 1;
          continue;
        }

        if (/^\s*$/.test(line)) {
          cursor += 1;
          continue;
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(
            h('hr', {
              key: 'b' + seed,
              style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))', margin: '8px 0' },
            }),
          );
          seed += 1;
          cursor += 1;
          continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          blocks.push(h('div', { key: 'b' + seed, style: headingStyle(heading[1].length) }, renderInline(heading[2], 'h' + seed)));
          seed += 1;
          cursor += 1;
          continue;
        }

        if (/^\s*>/.test(line)) {
          const body = [];
          while (cursor < lines.length && /^\s*>/.test(lines[cursor])) {
            body.push(lines[cursor].replace(/^\s*>\s?/, ''));
            cursor += 1;
          }
          blocks.push(
            h(
              'div',
              {
                key: 'b' + seed,
                style: {
                  margin: '2px 0 8px',
                  paddingLeft: 9,
                  borderLeft: '3px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.34))',
                  opacity: 0.92,
                },
              },
              renderInline(body.join('\n'), 'q' + seed),
            ),
          );
          seed += 1;
          continue;
        }

        const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
        const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
        if (unordered || ordered) {
          const isOrdered = Boolean(ordered);
          const entries = [];
          let start = 1;
          while (cursor < lines.length) {
            const nextUnordered = /^\s*[-*+]\s+(.*)$/.exec(lines[cursor]);
            const nextOrdered = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[cursor]);
            if (isOrdered && nextOrdered) {
              if (entries.length === 0) start = Number(nextOrdered[1]) || 1;
              entries.push(nextOrdered[2]);
            } else if (!isOrdered && nextUnordered) {
              entries.push(nextUnordered[1]);
            } else {
              break;
            }
            cursor += 1;
          }
          blocks.push(
            h(
              isOrdered ? 'ol' : 'ul',
              {
                key: 'b' + seed,
                start: isOrdered ? start : undefined,
                style: { margin: '2px 0 8px', paddingLeft: 22 },
              },
              entries.map((entry, position) =>
                h('li', { key: 'i' + position, style: { margin: '1px 0' } }, renderInline(entry, 'l' + seed + ':' + position)),
              ),
            ),
          );
          seed += 1;
          continue;
        }

        const paragraph = [];
        while (cursor < lines.length && !isBlockStart(lines[cursor])) {
          paragraph.push(lines[cursor]);
          cursor += 1;
        }
        if (paragraph.length === 0) {
          paragraph.push(lines[cursor]);
          cursor += 1;
        }
        blocks.push(h('div', { key: 'b' + seed, style: { margin: '0 0 7px' } }, renderInline(paragraph.join('\n'), 'p' + seed)));
        seed += 1;
      }

      return blocks;
    }

    // ------------------------------------------------------------------ icons

    function eyeIcon(active) {
      const children = [
        h('path', { key: 'l', d: 'M1.4 8S3.8 4.2 8 4.2 14.6 8 14.6 8 12.2 11.8 8 11.8 1.4 8 1.4 8Z' }),
        h('circle', { key: 'p', cx: 8, cy: 8, r: 2.05 }),
      ];
      if (active) children.push(h('path', { key: 's', d: 'M2.6 13.4 13.4 2.6' }));
      return children;
    }

    function trashIcon() {
      return [
        h('path', { key: 'a', d: 'M3.2 4.6h9.6' }),
        h('path', { key: 'b', d: 'M6.4 4.6V3.1h3.2v1.5' }),
        h('path', { key: 'c', d: 'M4.6 4.6l.62 8.3h5.56l.62-8.3' }),
      ];
    }

    function glyph(name, active) {
      const children = name === 'eye' ? eyeIcon(active) : trashIcon();
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 15,
          height: 15,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        children,
      );
    }

    // -------------------------------------------------------------- component

    const STACK_STYLE = { display: 'flex', flexDirection: 'column', gap: 8, width: '100%', minWidth: 0 };
    const HIDDEN_STYLE = { display: 'none' };

    // Row metrics copied from the shipped dock bar (`conversation.input.dock`'s
    // task entry): 24px line box inside 6px vertical padding = a 36px row.
    const HEADER_STYLE = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', minWidth: 0 };
    const TITLE_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      fontSize: 13,
      fontWeight: 500,
      lineHeight: '24px',
      color: 'var(--dsw-alias-label-primary)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };
    const ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' };
    const PREVIEW_STYLE = {
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
      padding: '9px 12px 11px',
      maxHeight: PREVIEW_MAX_HEIGHT,
      overflowY: 'auto',
      overflowX: 'hidden',
      fontFamily: MONO_FONT,
      fontSize: 12.5,
      lineHeight: 1.62,
      color: 'var(--dsw-alias-label-primary)',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    };
    const MUTED_STYLE = { color: 'var(--dsw-alias-label-secondary)', opacity: 0.9 };

    /**
     * Width formula copied verbatim from the shipped dock entry (`.aSus8q_root`):
     * the dock column is wider than the composer card, so an entry that fills it
     * with `width: 100%` spills past the composer. The host's own bars inset
     * themselves by two side clearances and four dock insets and center, which
     * lines them up with the composer card.
     */
    const SIDE_CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)';
    const DOCK_INSET = 'var(--dsh-composer-dock-inset, 8px)';
    const CARD_MAX_WIDTH = 'var(--dsh-composer-card-max-width, 952px)';
    const DOCKED_WIDTH = `calc(100% - ${SIDE_CLEARANCE} - ${SIDE_CLEARANCE} - ${DOCK_INSET} - ${DOCK_INSET} - ${DOCK_INSET} - ${DOCK_INSET})`;
    const DOCKED_MAX_WIDTH = `calc(${CARD_MAX_WIDTH} - ${DOCK_INSET} - ${DOCK_INSET} - ${DOCK_INSET} - ${DOCK_INSET})`;

    /** One width for both states: collapsed row and expanded preview alike. */
    const CARD_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      width: DOCKED_WIDTH,
      maxWidth: DOCKED_MAX_WIDTH,
      // Menu-material surface, same tokens as the shipped dock bar.
      backgroundColor: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.07)))',
      borderRadius: 'var(--dsw-radius-lg, 12px)',
      boxShadow: 'var(--dsw-elevation-panel, none)',
      backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
      '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
      border: 0,
      flex: 'none',
      margin: '0 auto',
      overflow: 'hidden',
    };

    function IconButton(props) {
      const [hover, setHover] = React.useState(false);
      const active = Boolean(props.active);
      const danger = Boolean(props.danger) && hover;
      const color = danger
        ? 'var(--dsw-alias-state-error-primary, #e5484d)'
        : hover || active
          ? 'var(--dsw-alias-label-primary)'
          : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))';
      return h(
        'button',
        {
          type: 'button',
          title: props.label,
          'aria-label': props.label,
          'aria-pressed': active ? 'true' : undefined,
          // Keep the caret in the editor: never let the button take focus.
          onMouseDown: (event) => event.preventDefault(),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: props.onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            padding: 0,
            border: 'none',
            borderRadius: 6,
            background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15))' : 'transparent',
            color,
            cursor: 'pointer',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        glyph(props.icon, active),
      );
    }

    function TextButton(props) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          title: props.label,
          onMouseDown: (event) => event.preventDefault(),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: props.onClick,
          style: {
            border: 'none',
            borderRadius: 6,
            padding: '3px 8px',
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: '18px',
            background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15))' : 'transparent',
            color: hover ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
            cursor: 'pointer',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        props.label,
      );
    }

    function DocGlyph() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: {
            display: 'block',
            flex: '0 0 auto',
            color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
          },
        },
        h('path', { d: 'M4 1.9h5.1L12.6 5v9.1H4z' }),
        h('path', { d: 'M9.1 1.9V5h3.5' }),
        h('path', { d: 'M6.2 8.3h4.3M6.2 10.7h4.3' }),
      );
    }

    function PastePackerStack(props) {
      const useInput = props.useInput;
      const occurrences = useInput((state) => (state && state.occurrences) || EMPTY_OCCURRENCES);
      const draft = useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''));

      const rootRef = React.useRef(null);
      const actionsRef = React.useRef(null);
      const draftRef = React.useRef('');
      const [openRefs, setOpenRefs] = React.useState(NO_REFS);

      React.useEffect(() => {
        actionsRef.current = props.inputActions || null;
      }, [props.inputActions]);

      React.useEffect(() => {
        draftRef.current = draft;
      }, [draft]);

      React.useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;
        let cachedInput = null;
        const entry = {
          inputElement() {
            if (cachedInput && cachedInput.isConnected) return cachedInput;
            cachedInput = resolveComposerInput(root);
            return cachedInput;
          },
          actions() {
            return actionsRef.current;
          },
          actx() {
            const sessions = runtime.sessions;
            const sessionId = props.session && props.session.sessionId;
            if (!sessions || !sessionId) return null;
            try {
              if (typeof sessions.binding === 'function') {
                const binding = sessions.binding(sessionId);
                if (binding && binding.ctx) return binding.ctx;
              }
              if (typeof sessions.scope === 'function') return sessions.scope(sessionId) || null;
            } catch (error) {
              return null;
            }
            return null;
          },
        };
        composers.add(entry);
        return () => {
          composers.delete(entry);
        };
      }, [props.session]);

      function togglePreview(ref) {
        setOpenRefs((previous) => {
          const next = new Set(previous);
          if (next.has(ref)) next.delete(ref);
          else next.add(ref);
          return next;
        });
      }

      function forget(ref) {
        items.delete(ref);
        saveStore();
        setOpenRefs((previous) => {
          if (!previous.has(ref)) return previous;
          const next = new Set(previous);
          next.delete(ref);
          return next;
        });
      }

      function expandCard(occurrence, ref) {
        const item = items.get(ref);
        const actions = actionsRef.current;
        if (!item || !actions) return;
        if (replaceOccurrence(actions, occurrence, item.text, draftRef.current)) forget(ref);
      }

      function removeCard(occurrence, ref) {
        const actions = actionsRef.current;
        if (!actions) return;
        if (replaceOccurrence(actions, occurrence, '', draftRef.current)) forget(ref);
      }

      const cards = [];
      for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index];
        if (!occurrence || occurrence.source !== SOURCE) continue;
        const ref = String(occurrence.ref);
        const item = items.get(ref);
        const open = openRefs.has(ref);
        const title = occurrence.label || (item ? labelFor(item) : labelBare(ref));
        cards.push(
          h(
            'div',
            {
              key: occurrence.occurrenceId === undefined ? ref : 'o' + occurrence.occurrenceId,
              style: CARD_STYLE,
            },
            h(
              'div',
              { style: HEADER_STYLE },
              h(DocGlyph, { key: 'g' }),
              h('div', { key: 't', style: TITLE_STYLE, title }, title),
              h(
                'div',
                { key: 'a', style: ACTIONS_STYLE },
                h(IconButton, {
                  key: 'eye',
                  icon: 'eye',
                  active: open,
                  label: open ? t('previewHide') : t('preview'),
                  onClick: () => togglePreview(ref),
                }),
                h(TextButton, { key: 'expand', label: t('expand'), onClick: () => expandCard(occurrence, ref) }),
                h(IconButton, {
                  key: 'trash',
                  icon: 'trash',
                  danger: true,
                  label: t('remove'),
                  onClick: () => removeCard(occurrence, ref),
                }),
              ),
            ),
            open
              ? h(
                  'div',
                  { key: 'p', style: PREVIEW_STYLE },
                  item
                    ? item.text === ''
                      ? h('div', { style: MUTED_STYLE }, t('empty'))
                      : renderMarkdown(item.text)
                    : h('div', { style: MUTED_STYLE }, t('missing')),
                )
              : null,
          ),
        );
      }

      // The wrapper always renders: the paste listener needs a stable anchor to
      // find this composer's input element before the first card exists.
      return h('div', { ref: rootRef, style: cards.length > 0 ? STACK_STYLE : HIDDEN_STYLE }, cards);
    }

    function PastePackerDock(props) {
      if (!props || typeof props.useInput !== 'function') return null;
      return h(PastePackerStack, props);
    }

    // -------------------------------------------------------------- install

    function installLocale(ctx) {
      try {
        const locale = ctx.locale;
        if (!locale || typeof locale.register !== 'function') return;
        const register = (id, dict) => {
          try {
            ctx.effect(() => locale.register(NS, id, dict));
          } catch (error) {
            // Locale id not accepted by this build: keep the Chinese default.
          }
        };
        register('en', DICTS.en);
        register('en-US', DICTS.en);
        register('en-GB', DICTS.en);
        register('zh', DICTS.zh);
        register('zh-CN', DICTS.zh);
        register('zh-Hans', DICTS.zh);
        if (typeof locale.bind === 'function') translate = locale.bind(NS);
      } catch (error) {
        translate = null;
      }
    }

    function installPasteListener(ctx) {
      ctx.effect(() => {
        document.addEventListener('paste', handlePaste, true);
        return () => document.removeEventListener('paste', handlePaste, true);
      });
    }

    function installTriggerSource(ctx) {
      if (typeof ctx.inject !== 'function') {
        console.error('[dsh-paste-packer] ctx.inject is unavailable; packing is disabled (paste stays native).');
        return;
      }
      ctx.inject(['inputTriggers', 'conversation', 'sessions'], (scope) => {
        runtime.conversation = scope.conversation || null;
        runtime.sessions = scope.sessions || null;
        const source = {
          trigger: '/',
          name: SOURCE,
          // Last in the slash menu; the group is always empty, and an empty
          // ready group never renders (the menu auto-closes).
          order: 900,
          showGroupTitle: false,
          candidates: async () => [],
          onPick: () => undefined,
          codec: {
            clipboardText: (ref) => {
              const item = items.get(String(ref));
              return item ? labelFor(item) : labelBare(ref);
            },
            serialize: async (ref) => {
              const item = items.get(String(ref));
              if (item) return item.text;
              console.warn(
                '[dsh-paste-packer] packed text #' + String(ref) + ' is gone (storage cleared or another browser); sending the placeholder.',
              );
              return labelBare(ref);
            },
          },
        };
        scope.effect(() => {
          const dispose = scope.inputTriggers.registerSource(source);
          runtime.sourceReady = true;
          return () => {
            runtime.sourceReady = false;
            dispose();
          };
        });
      });
    }

    function installSlot(ctx) {
      // Last in the dock, so the cards sit immediately above the composer card
      // (the shipped entries use 0..400 for their own strips).
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: SOURCE, order: 500 }, PastePackerDock),
      );
    }

    loadStore();

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        runtime.ctx = ctx;
        try {
          installLocale(ctx);
        } catch (error) {
          console.warn('[dsh-paste-packer] locale registration failed', error);
        }
        try {
          installSlot(ctx);
        } catch (error) {
          console.error('[dsh-paste-packer] slot registration failed', error);
        }
        try {
          installPasteListener(ctx);
        } catch (error) {
          console.error('[dsh-paste-packer] paste listener install failed', error);
        }
        try {
          installTriggerSource(ctx);
        } catch (error) {
          console.error('[dsh-paste-packer] trigger source install failed', error);
        }
      },
    };
  },
});
