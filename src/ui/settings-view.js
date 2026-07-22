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

export function renderSettings(state, width, height, theme, animationFrame = 0) {
  const view = settingsViewModel(state);
  const leftWidth = Math.max(24, Math.min(34, Math.floor(width * 0.3)));
  const rightWidth = Math.max(26, width - leftWidth - 2);
  const categories = WorkspacePane({
    title: ' CATEGORIES ',
    active: view.focus === 'categories' && !view.modal,
    height,
    theme,
    children: [SelectList({
      title: 'Settings',
      items: view.definitions,
      selectedIndex: view.categoryIndex,
      windowSize: Math.max(2, height - 6),
      getLabel: (item) => `${item.label}  ›`,
      getDescription: () => '',
      wrapItems: false,
      maxItemLines: 1,
      theme,
      pointerId: 'zipflow:settings-categories',
      onSelect: (_item, index) => state.dispatch?.({ type: 'settings-select-setting', index }),
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
    title: ' SEARCH MODELS ', active: true, height: 5, theme,
    children: [
      ZipflowTextEditorView({
        title: ' Filter ', value: state.searchEditor.value, cursor: state.searchEditor.cursor,
        width: overlayWidth - 4, height: 3, placeholder: 'model name, author, parameters…', lineNumbers: false, theme,
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
  const items = showingChoices ? view.choices : view.parameters;
  const nestedChoice = showingChoices && !view.direct;
  const title = nestedChoice
    ? ` ${view.activeParameter?.label?.toUpperCase() ?? 'SELECT'} `
    : ` ${(view.pageTitle ?? view.selectedSetting.label).toUpperCase()} `;
  const selectedParameter = !showingChoices ? items[view.parameterIndex] : null;
  const summary = nestedChoice ? [] : settingsPageSummary(state, view.selectedSetting);
  const pageContext = nestedChoice
    ? view.activeParameter?.description ?? ''
    : summary.length ? summary.join(' · ') : view.selectedSetting.description;
  const selectedChoice = showingChoices ? items[view.choiceIndex] : null;
  const parameterDescription = showingChoices
    ? selectedChoice?.disabled ? selectedChoice.disabledReason ?? '' : selectedChoice?.description ?? ''
    : selectedParameter?.disabled ? selectedParameter.disabledReason ?? '' : selectedParameter?.description ?? '';
  return WorkspacePane({
    title,
    active: view.focus !== 'categories' && !view.modal,
    height,
    theme,
    children: [
      ContextDock({ text: pageContext, rows: 2, width: Math.max(20, width - 4), theme }),
      SelectList({
        title: showingChoices ? 'Options' : 'Parameters',
        items,
        selectedIndex: showingChoices ? view.choiceIndex : view.parameterIndex,
        windowSize: Math.max(2, height - 8),
        getLabel: (item) => showingChoices
          ? choiceLabel(state, item, theme, animationFrame)
          : parameterLabel(state, item, theme, animationFrame),
        getDescription: () => '',
        getDisabled: (item) => Boolean(item.disabled || item.blocked || item.loading),
        getDisabledIndicator: (item) => item.loading || item.blocked ? '' : '×',
        wrapItems: false,
        maxItemLines: 1,
        theme,
        pointerId: showingChoices ? 'zipflow:settings-choices' : 'zipflow:settings-parameters',
        onSelect: (_item, index) => state.dispatch?.({
          type: showingChoices ? 'settings-select-choice' : 'settings-select-parameter',
          index,
        }),
      }),
      ContextDock({ text: parameterDescription, rows: 1, width: Math.max(20, width - 4), theme }),
    ].filter(Boolean),
  });
}

function renderModelConfigPage(state, view, width, height, theme, animationFrame) {
  const choices = view.focus === 'choices';
  const items = choices ? view.choices : view.parameters;
  const model = view.model;
  const info = [
    model.paramsString ? `${model.paramsString} parameters` : null,
    model.quantization,
    model.loaded ? 'Loaded instance' : 'Not loaded',
    model.maxContextLength ? `maximum context ${model.maxContextLength.toLocaleString('en-US')}` : null,
  ].filter(Boolean).join(' · ');
  const selectedParameter = !choices ? items[view.parameterIndex] : null;
  const pageContext = choices ? view.activeParameter?.description ?? '' : [info, view.error].filter(Boolean).join(' · ');
  const parameterDescription = choices ? '' : selectedParameter?.description ?? '';
  return WorkspacePane({
    title: ` ${model.label.toUpperCase()} `,
    active: !state.settingsPanel?.modal,
    height,
    theme,
    children: [
      ContextDock({ text: pageContext, rows: 2, width: Math.max(20, width - 4), theme, token: view.error ? 'danger' : 'text' }),
      SelectList({
        title: choices ? 'Options' : 'Load configuration',
        items,
        selectedIndex: choices ? view.choiceIndex : view.parameterIndex,
        windowSize: Math.max(2, height - 8),
        getLabel: (item) => {
          if (!choices && item.id === 'use-model' && view.loading) return spinnerLabel(animationFrame, item.label);
          return choices
            ? `${item.value === view.values[view.activeParameter.id] ? '●' : '○'} ${item.label}`
            : `${item.label}${item.value ? `: ${item.value}` : ''}`;
        },
        getDescription: () => '',
        getDisabled: (item) => Boolean(item.disabled || item.blocked || item.loading),
        getDisabledIndicator: (item) => item.loading || item.blocked ? '' : '×',
        wrapItems: false,
        maxItemLines: 1,
        theme,
        pointerId: choices ? 'zipflow:model-config-choices' : 'zipflow:model-config-parameters',
        onSelect: (_item, index) => state.dispatch?.({
          type: choices ? 'settings-model-select-choice' : 'settings-model-select-parameter',
          index,
        }),
      }),
      ContextDock({ text: parameterDescription, rows: 1, width: Math.max(20, width - 4), theme }),
    ].filter(Boolean),
  });
}

function spinnerLabel(animationFrame, label) {
  return renderNode(Spinner({ frame: animationFrame, label }), Math.max(8, String(label ?? '').length + 4))[0].trimEnd();
}

function parameterLabel(state, item, theme, animationFrame) {
  if (item.loading) return spinnerLabel(animationFrame, item.label);
  if (item.type === 'section') return color(theme, 'accent', `── ${item.label} ──`);
  if (item.type === 'stat') return `${color(theme, 'textMuted', item.label)}: ${item.value}`;
  const label = item.value ? `${item.label}: ${item.value}` : item.label;
  return ['choice', 'input', 'subpage'].includes(item.type) ? `${label}  ›` : label;
}

function choiceLabel(state, item, theme, animationFrame) {
  if (item.action === 'refresh-models' && item.loading) {
    return renderNode(Spinner({
      frame: animationFrame,
      label: 'Refreshing available models',
    }), 48)[0].trimEnd();
  }
  if (item.model) {
    const selected = Boolean(item.selected);
    const status = item.model.loaded ? 'Loaded' : 'Not loaded';
    return `${selected ? '●' : '○'} ${item.label} ${color(theme, 'textMuted', `· ${status}`)}  ›`;
  }
  if (!item.settingId) return item.label;
  const selected = item.selected || state.settings[item.settingId] === item.value;
  return `${selected ? '●' : '○'} ${item.label}`;
}

function renderSettingsModal({ content, modal, state, width, height, theme }) {
  const modalWidth = Math.max(40, Math.min(68, width - 10));
  const instructions = modal.field.instructions ?? [];
  const buildModal = ({ width: availableWidth, height: availableHeight }) => {
    const innerWidth = Math.max(26, Math.min(modalWidth - 4, availableWidth - 4));
    const children = [
      Text(modal.field.description, { wrap: true }),
      ...instructions.map((line) => Text(color(theme, 'text', line), { wrap: true })),
      modal.field.unitHint ? Text(color(theme, 'accent', modal.field.unitHint), { wrap: true }) : null,
      Text(''),
      ZipflowTextEditorView({
        title: ` ${modal.field.label} `,
        value: state.editor.value,
        cursor: state.editor.cursor,
        width: innerWidth,
        height: 3,
        placeholder: modal.field.placeholder ?? '',
        lineNumbers: false,
        theme,
      }),
      modal.error ? Text(color(theme, 'danger', modal.error), { wrap: true }) : null,
    ].filter(Boolean);
    let node = Modal({
      title: ` Edit ${modal.field.label} `,
      children,
      footer: modal.field.path ? '↑/↓ choose · Tab/Enter complete · Esc cancel' : 'Enter save · Esc cancel',
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
    top: () => ({ type: 'modal', width: modalWidth + 2, opaqueRows: true, render: buildModal }),
  };
  return OverlayHost({ content, manager, theme, width, height, dim: true, toastBottomMargin: 0 });
}
