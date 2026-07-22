import {
  BottomOverlay,
  Modal,
  OverlayHost,
  ScrollPane,
  SplitPane,
  SelectList,
  Spinner,
  Text,
  WorkspacePane,
  color,
  renderNode,
} from 'terlio.js';
import { settingsViewModel } from '../app/settings-panel.js';
import { settingsPageSummary } from '../app/settings-options.js';
import { PathCompletionPopup } from './path-completion.js';
import { renderModelReplayWorkspace } from './model-replay-view.js';
import { ZipflowTextEditorView } from './editor-view.js';
import { ContextDock } from './context-dock.js';
import { selectRowIndex, selectRows } from './select-rows.js';
import { localizeUiItem, translateForState as t } from '../i18n/index.js';

const SETTINGS_CONTEXT_ROWS = 2;

export function renderSettings(state, width, height, theme, animationFrame = 0) {
  const view = settingsViewModel(state);
  const leftWidth = Math.max(24, Math.min(34, Math.floor(width * 0.3)));
  const rightWidth = Math.max(26, width - leftWidth - 2);
  const localizedDefinitions = view.definitions.map((item) => localizeUiItem(state, item));
  const categoryRows = selectRows(localizedDefinitions, (item) => oneLineLabel(item.label));
  const categories = WorkspacePane({
    title: ` ${t(state, 'Categories').toUpperCase()} `,
    active: view.focus === 'categories' && !view.modal,
    height,
    theme,
    children: [SelectList({
      title: t(state, 'Settings'),
      items: categoryRows,
      selectedIndex: view.categoryIndex,
      windowSize: Math.max(2, height - 6),
      getLabel: (item) => item.label,
      wrapItems: false,
      maxItemLines: 1,
      theme,
      pointerId: 'zipflow:settings-categories',
      onSelect: (item, index) => state.dispatch?.({ type: 'settings-select-setting', index: selectRowIndex(item, index) }),
    })],
  });
  const right = view.modelConfig
    ? renderModelConfigPage(state, view.modelConfig, rightWidth, height, theme, animationFrame)
    : renderSettingsPage(state, view, rightWidth, height, theme, animationFrame);
  const content = SplitPane({
    orientation: 'horizontal',
    gap: 2,
    height,
    focus: view.focus === 'categories' ? 'categories' : 'details',
    theme,
    panes: [
      { id: 'categories', size: leftWidth, min: 24, node: categories },
      { id: 'details', size: rightWidth, min: 26, grow: 1, node: right },
    ],
  });
  if (state.settingsPanel?.modelTestWorkspace) {
    return renderModelReplayWorkspace({ content, state, width, height, theme, animationFrame });
  }
  if (!view.modal && !view.choiceSearch?.active) return content;
  if (!view.modal && view.choiceSearch?.active) return renderChoiceSearch({ content, state, width, height, theme });
  return renderSettingsModal({ content, modal: view.modal, state, width, height, theme });
}


function renderChoiceSearch({ content, state, width, height, theme }) {
  const overlayWidth = Math.max(34, Math.min(72, width - 6));
  const overlay = WorkspacePane({
    title: ` ${t(state, 'Search models').toUpperCase()} `, active: true, height: 5, theme,
    children: [
      ZipflowTextEditorView({
        title: ` ${t(state, 'Filter')} `, value: state.searchEditor.value, cursor: state.searchEditor.cursor,
        width: overlayWidth - 4, height: 3, placeholder: t(state, 'model name, author, parameters…'), lineNumbers: false, theme,
      }),
    ],
  });
  return BottomOverlay({
    content, overlay, height, bottom: 1, left: 2, right: 2, width: overlayWidth,
    align: 'center', opaque: true,
  });
}

function renderSettingsPage(state, view, width, height, theme, animationFrame) {
  const showingChoices = view.direct || view.focus === 'choices';
  const rawItems = showingChoices ? view.choices : view.parameters;
  const items = rawItems.map((item) => localizeUiItem(state, item));
  const nestedChoice = showingChoices && !view.direct;
  const activeParameter = localizeUiItem(state, view.activeParameter);
  const selectedSetting = localizeUiItem(state, view.selectedSetting);
  const title = nestedChoice
    ? ` ${(activeParameter?.label ?? t(state, 'Choose')).toUpperCase()} `
    : ` ${t(state, view.pageTitle ?? selectedSetting.label).toUpperCase()} `;
  const selectedParameter = !showingChoices ? items[view.parameterIndex] : null;
  const summary = nestedChoice ? [] : settingsPageSummary(state, view.selectedSetting).map((line) => t(state, line));
  const pageContext = nestedChoice
    ? activeParameter?.description ?? ''
    : summary.length ? summary.join(' · ') : selectedSetting.description;
  const selectedChoice = showingChoices ? items[view.choiceIndex] : null;
  const parameterDescription = showingChoices
    ? selectedChoice?.disabled ? selectedChoice.disabledReason ?? '' : selectedChoice?.description ?? ''
    : selectedParameter?.disabled ? selectedParameter.disabledReason ?? '' : selectedParameter?.description ?? '';
  const context = nestedChoice
    ? joinContextLines(pageContext, parameterDescription)
    : parameterDescription || pageContext;
  const rows = selectRows(items, (item) => oneLineLabel(showingChoices
    ? choiceLabel(state, item, theme, animationFrame)
    : parameterLabel(state, item, theme, animationFrame)));
  return WorkspacePane({
    title,
    active: view.focus !== 'categories' && !view.modal,
    height,
    theme,
    footerNode: ContextDock({ text: context, rows: SETTINGS_CONTEXT_ROWS, width: Math.max(20, width - 4), theme, wrapSingleLine: false }),
    footerMinHeight: SETTINGS_CONTEXT_ROWS,
    children: [
      SelectList({
        title: t(state, showingChoices ? 'Options' : 'Parameters'),
        items: rows,
        selectedIndex: showingChoices ? view.choiceIndex : view.parameterIndex,
        windowSize: Math.max(2, height - 7),
        getLabel: (item) => item.label,
        getDisabled: (item) => Boolean(item.disabled || item.blocked || item.loading),
        getDisabledIndicator: (item) => item.loading || item.blocked ? '' : '×',
        wrapItems: false,
        maxItemLines: 1,
        theme,
        pointerId: showingChoices ? 'zipflow:settings-choices' : 'zipflow:settings-parameters',
        onSelect: (item, index) => state.dispatch?.({
          type: showingChoices ? 'settings-select-choice' : 'settings-select-parameter',
          index: selectRowIndex(item, index),
        }),
      }),
    ].filter(Boolean),
  });
}

function renderModelConfigPage(state, view, width, height, theme, animationFrame) {
  const choices = view.focus === 'choices';
  const items = (choices ? view.choices : view.parameters).map((item) => localizeUiItem(state, item));
  const model = view.model;
  const info = [
    model.paramsString ? `${model.paramsString} parameters` : null,
    model.quantization,
    model.loaded ? t(state, 'Loaded instance') : t(state, 'Not loaded'),
    model.maxContextLength ? t(state, `maximum context ${model.maxContextLength.toLocaleString('en-US')}`) : null,
  ].filter(Boolean).join(' · ');
  const selectedParameter = !choices ? items[view.parameterIndex] : null;
  const pageContext = choices ? localizeUiItem(state, view.activeParameter)?.description ?? '' : [info, t(state, view.error)].filter(Boolean).join(' · ');
  const selectedChoice = choices ? items[view.choiceIndex] : null;
  const parameterDescription = choices
    ? selectedChoice?.disabled ? selectedChoice.disabledReason ?? '' : selectedChoice?.description ?? ''
    : selectedParameter?.description ?? '';
  const context = choices
    ? joinContextLines(pageContext, parameterDescription)
    : parameterDescription || pageContext;
  const rows = selectRows(items, (item) => oneLineLabel((() => {
    if (!choices && item.id === 'use-model' && view.loading) return spinnerLabel(animationFrame, item.label);
    return choices
      ? `${item.value === view.values[view.activeParameter.id] ? '●' : '○'} ${item.label}`
      : `${item.label}${item.value ? `: ${item.value}` : ''}`;
  })()));
  return WorkspacePane({
    title: ` ${t(state, model.label).toUpperCase()} `,
    active: !state.settingsPanel?.modal,
    height,
    theme,
    footerNode: ContextDock({ text: context, rows: SETTINGS_CONTEXT_ROWS, width: Math.max(20, width - 4), theme, token: view.error ? 'danger' : 'text', wrapSingleLine: false }),
    footerMinHeight: SETTINGS_CONTEXT_ROWS,
    children: [
      SelectList({
        title: t(state, choices ? 'Options' : 'Load configuration'),
        items: rows,
        selectedIndex: choices ? view.choiceIndex : view.parameterIndex,
        windowSize: Math.max(2, height - 7),
        getLabel: (item) => item.label,
        getDisabled: (item) => Boolean(item.disabled || item.blocked || item.loading),
        getDisabledIndicator: (item) => item.loading || item.blocked ? '' : '×',
        wrapItems: false,
        maxItemLines: 1,
        theme,
        pointerId: choices ? 'zipflow:model-config-choices' : 'zipflow:model-config-parameters',
        onSelect: (item, index) => state.dispatch?.({
          type: choices ? 'settings-model-select-choice' : 'settings-model-select-parameter',
          index: selectRowIndex(item, index),
        }),
      }),
    ].filter(Boolean),
  });
}


function oneLineLabel(value) {
  return String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/[\t ]{2,}/g, ' ')
    .trim();
}

function joinContextLines(...lines) {
  return lines.map((line) => String(line ?? '').trim()).filter(Boolean).filter((line, index, values) => values.indexOf(line) === index).join('\n');
}

function spinnerLabel(animationFrame, label) {
  return renderNode(Spinner({ frame: animationFrame, label }), Math.max(8, String(label ?? '').length + 4))[0].trimEnd();
}

function parameterLabel(state, item, theme, animationFrame) {
  if (item.loading) return spinnerLabel(animationFrame, item.label);
  if (item.type === 'section') return color(theme, 'accent', `── ${item.label} ──`);
  if (item.type === 'stat') return `${color(theme, 'textMuted', item.label)}: ${item.value}`;
  const label = item.value ? `${item.label}: ${item.value}` : item.label;
  return ['choice', 'input', 'subpage'].includes(item.type) ? `${label} ›` : label;
}

function choiceLabel(state, item, theme, animationFrame) {
  if (item.action === 'refresh-models' && item.loading) {
    return renderNode(Spinner({
      frame: animationFrame,
      label: t(state, 'Refreshing available models'),
    }), 48)[0].trimEnd();
  }
  if (item.model) {
    const selected = Boolean(item.selected);
    const status = item.model.loaded ? t(state, 'Loaded') : t(state, 'Not loaded');
    return `${selected ? '●' : '○'} ${item.label} ${color(theme, 'textMuted', `· ${status}`)} ›`;
  }
  if (!item.settingId) return item.label;
  const selected = item.selected || state.settings[item.settingId] === item.value;
  return `${selected ? '●' : '○'} ${item.label}`;
}

function renderSettingsModal({ content, modal, state, width, height, theme }) {
  const modalWidth = Math.max(40, Math.min(68, width - 10));
  const instructions = (modal.field.instructions ?? []).map((line) => t(state, line));
  const buildModal = ({ width: availableWidth, height: availableHeight }) => {
    const innerWidth = Math.max(26, Math.min(modalWidth - 4, availableWidth - 4));
    const children = [
      Text(t(state, modal.field.description), { wrap: true }),
      ...instructions.map((line) => Text(color(theme, 'text', line), { wrap: true })),
      modal.field.unitHint ? Text(color(theme, 'accent', t(state, modal.field.unitHint)), { wrap: true }) : null,
      Text(''),
      ZipflowTextEditorView({
        title: ` ${t(state, modal.field.label)} `,
        value: state.editor.value,
        cursor: state.editor.cursor,
        width: innerWidth,
        height: 3,
        placeholder: t(state, modal.field.placeholder ?? ''),
        lineNumbers: false,
        theme,
      }),
      modal.error ? Text(color(theme, 'danger', t(state, modal.error)), { wrap: true }) : null,
    ].filter(Boolean);
    let node = Modal({
      title: ` ${t(state, 'Edit')} ${t(state, modal.field.label)} `,
      children,
      footer: t(state, modal.field.path ? '↑/↓ choose · Tab/Enter complete · Esc cancel' : 'Enter save · Esc cancel'),
    });
    const completion = state.pathSuggestions;
    if (modal.field.path && completion?.owner === 'settings-modal' && completion.items?.length && state.pathSuggestionActive) {
      const overlayHeight = Math.min(6, Math.max(4, completion.items.length + 2));
      node = BottomOverlay({
        content: node,
        overlay: PathCompletionPopup({ state, width: innerWidth, height: overlayHeight, theme }),
        height: Math.max(10, availableHeight),
        bottom: 2,
        left: 1,
        right: 1,
        width: innerWidth,
        align: 'center',
        opaque: true,
      });
    }
    return node;
  };
  const manager = {
    toasts: [],
    top: () => ({ type: 'modal', width: modalWidth + 2, opaqueRows: true, shadow: true, render: buildModal }),
  };
  return OverlayHost({ content, manager, theme, width, height, dim: true, toastBottomMargin: 0 });
}
