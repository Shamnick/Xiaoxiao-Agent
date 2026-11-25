import { basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { diagnosticCount, linter, openLintPanel } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { sql } from '@codemirror/lang-sql';

const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.function(tags.variableName), tags.heading, tags.tagName], color: 'var(--syntax-name)' }
]));

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-code)', lineHeight: '1.65', fontSize: '13px' },
  '.cm-content': { padding: '12px 0 30px', caretColor: 'var(--text)' },
  '.cm-line': { paddingInline: '13px' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none', minWidth: '44px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--subtle)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
  '.cm-panels': { backgroundColor: 'var(--subtle)', color: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-ghost-code': { color: 'var(--muted)', fontStyle: 'italic', whiteSpace: 'pre', pointerEvents: 'none' },
  '.cm-diagnostic': { overflowWrap: 'anywhere' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--deletion)', textUnderlineOffset: '2px' }
});

const wrapping = new Compartment();
const setSuggestion = StateEffect.define();
class SuggestionWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return this.text === other.text; }
  get lineBreaks() { return this.text.split('\n').length - 1; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost-code';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }
}
const suggestion = StateField.define({
  create: () => null,
  update(value, transaction) {
    const effect = transaction.effects.find(item => item.is(setSuggestion));
    if (effect) return effect.value;
    return transaction.docChanged || transaction.selection ? null : value;
  },
  provide: field => EditorView.decorations.from(field, value => value
    ? Decoration.set([Decoration.widget({ widget: new SuggestionWidget(value.text), side: 1 }).range(value.from)])
    : Decoration.none)
});

const syntaxDiagnostics = linter(view => {
  const { state } = view;
  const tree = ensureSyntaxTree(state, state.doc.length, 35);
  const results = [];
  tree?.iterate({ enter({ type, from, to }) {
    if (results.length >= 40) return false;
    if (type.isError) results.push({ from, to, severity: 'error', message: '此处可能存在语法错误' });
  } });
  return results;
}, { delay: 420 });

function insert(view, from, to, text) {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.complete',
    scrollIntoView: true
  });
}

function languageFor(path) {
  const extension = path.split('.').at(-1).toLowerCase();
  if (['js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'].includes(extension)) {
    return javascript({ jsx: ['jsx', 'tsx'].includes(extension), typescript: /^(?:[mc]?ts|tsx)$/.test(extension) });
  }
  return ({ json, py: python, md: markdown, markdown, css, html, htm: html, sql }[extension])?.() || [];
}

function openEditor(container, options) {
  const { snapshot } = options;
  const view = new EditorView({
    parent: container,
    state: snapshot?.state || EditorState.create({
      doc: options.text.replace(/\r\n|\r/g, '\n'),
      extensions: [
        EditorView.cspNonce.of(document.querySelector('meta[name="editor-style-nonce"]').content),
        basicSetup, highlighting, theme, languageFor(options.path), EditorState.tabSize.of(2),
        suggestion,
        /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|py|css)$/i.test(options.path) && !options.readOnly ? syntaxDiagnostics : [],
        EditorState.readOnly.of(options.readOnly), EditorState.allowMultipleSelections.of(false),
        EditorState.phrases.of({ Diagnostics: '语法提示', 'No diagnostics': '没有语法提示', close: '关闭' }),
        EditorView.contentAttributes.of({ 'aria-label': '代码编辑器', 'aria-readonly': String(options.readOnly), spellcheck: 'false' }),
        wrapping.of(options.wrap ? EditorView.lineWrapping : []),
        keymap.of([{ key: 'Mod-s', run: () => { options.onSave(); return true; } }]),
        Prec.highest(EditorView.domEventHandlers({
          keydown(event) {
            return !event.isComposing && event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey
              && event.code === 'Slash' && options.onAssist('complete');
          }
        })),
        Prec.highest(keymap.of([
          { key: 'Alt-/', run: () => options.onAssist('complete') },
          { key: 'Mod-i', run: () => options.onAssist('edit') },
          { key: 'Tab', run: view => {
            const proposal = view.state.field(suggestion);
            if (!proposal) return false;
            insert(view, proposal.from, proposal.from, proposal.text);
            return true;
          } },
          { key: 'Escape', run: () => options.onAssist('cancel') }
        ])),
        EditorView.updateListener.of(update => {
          if (update.docChanged || update.selectionSet || diagnosticCount(update.state) !== diagnosticCount(update.startState)) {
            options.onUpdate(update.docChanged, update.selectionSet, update.transactions.some(transaction => transaction.isUserEvent('input.type')));
          }
        })
      ]
    })
  });
  if (snapshot) {
    view.scrollDOM.scrollTop = snapshot.top;
    view.scrollDOM.scrollLeft = snapshot.left;
  }
  return {
    text: () => view.state.doc.toString(),
    snapshot: () => ({ state: view.state, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }),
    issueCount: () => diagnosticCount(view.state),
    showIssues: () => openLintPanel(view),
    readyForAutoCompletion() {
      const { state } = view;
      const { head, empty } = state.selection.main;
      const line = state.doc.lineAt(head);
      return view.hasFocus && !view.compositionStarted && state.selection.ranges.length === 1 && empty && head === line.to && line.text.trim().length >= 3;
    },
    selection() {
      const { from, to, head } = view.state.selection.main;
      const line = view.state.doc.lineAt(head);
      return { from, to, line: line.number, column: head - line.from + 1 };
    },
    suggest: (from, text) => view.dispatch({ effects: setSuggestion.of({ from, text }) }),
    clearSuggestion() {
      if (view.state.field(suggestion)) view.dispatch({ effects: setSuggestion.of(null) });
    },
    replace: (from, to, text) => insert(view, from, to, text),
    wrap: enabled => view.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) }),
    focus: () => view.focus(),
    jump(number) {
      const { from, to } = view.state.doc.line(Math.max(1, Math.min(number, view.state.doc.lines)));
      view.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    },
    destroy: () => view.destroy()
  };
}

window.xiaoxiaoEditor = { open: openEditor };
