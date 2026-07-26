import { Modal, OverlayHost, SelectList, Spinner, Text, color } from 'terlio.js';
import { updateActions } from '../app/update-flow.js';
import { localizeUiItem, translateForState as t } from '../i18n/index.js';
import { selectRows } from './select-rows.js';
import { wheelScrollDelta } from './wheel.js';

export function renderUpdateOverlay({ content, state, width, height, theme, animationFrame = 0 }) {
  const prompt = state.updatePrompt;
  if (!prompt) return content;
  const modalWidth = Math.max(46, Math.min(76, width - 8));
  const actions = updateActions(prompt).map((item) => localizeUiItem(state, item));
  const rows = selectRows(actions, (item) => item.label);
  const manager = {
    toasts: [],
    top: () => ({
      type: 'modal', width: modalWidth + 2, opaqueRows: true, shadow: true,
      render: ({ width: availableWidth = modalWidth, height: availableHeight = height - 4 } = {}) => {
        const children = updateContent(state, prompt, actions, rows, availableWidth, availableHeight, theme, animationFrame);
        return Modal({
          title: ` ${t(state, updateTitle(prompt))} `,
          children,
          footer: t(state, updateFooter(prompt)),
        });
      },
    }),
  };
  return OverlayHost({ content, manager, theme, width, height, dim: true, toastBottomMargin: 0 });
}

function updateContent(state, prompt, actions, rows, width, height, theme, animationFrame = 0) {
  const children = [];
  if (prompt.phase === 'available') {
    children.push(
      Text(t(state, 'A newer Zipflow version is available.'), { wrap: true }),
      Text(''),
      Text(`${t(state, 'Installed version')}: ${prompt.currentVersion}`),
      Text(`${t(state, 'Available version')}: ${prompt.latestVersion}`),
      Text(''),
      Text(color(theme, 'textMuted', t(state, prompt.installSupported === false
        ? 'Automatic installation is available only when Zipflow is running from a global npm package.'
        : 'The update is downloaded and installed through the official npm registry.')), { wrap: true }),
    );
    if (prompt.installSupported === false) {
      children.push(Text(color(theme, 'textMuted', `${t(state, 'Install command')}: ${prompt.installCommand}`), { wrap: true }));
    }
  } else {
    children.push(Text(t(state, prompt.message, prompt.messageVariables ?? {}), { wrap: true }));
    if (prompt.detail) children.push(Text(color(theme, ['failed', 'uncertain'].includes(prompt.phase) ? 'danger' : 'textMuted', t(state, prompt.detail)), { wrap: true }));
    if (prompt.phase === 'installing') {
      children.push(Text(''), Spinner({ frame: animationFrame, label: t(state, prompt.cancelling ? 'Stopping safely' : 'Running npm install'), theme }));
    }
  }
  if (actions.length) {
    children.push(Text(''), SelectList({
      title: t(state, 'Choose'),
      items: rows,
      selectedIndex: prompt.selectedIndex,
      windowSize: Math.min(4, Math.max(1, height - 10)),
      getLabel: (item) => item.label,
      getDisabled: (item) => item.disabled,
      wrapItems: false,
      maxItemLines: 1,
      theme,
      pointerId: 'zipflow:update',
      onSelect: (item, index) => state.dispatch?.({ type: 'update-activate', id: actions[index]?.id }),
      onWheel: (event) => {
        const delta = wheelScrollDelta(event);
        if (delta) state.dispatch?.({ type: 'update-move', delta });
        event.preventDefault();
        event.stopPropagation?.();
      },
    }));
    const selectedDescription = actions[prompt.selectedIndex]?.description;
    if (selectedDescription) children.push(Text(color(theme, 'textMuted', selectedDescription), { wrap: true }));
  }
  return children;
}

function updateTitle(prompt) {
  if (prompt.phase === 'installing') return 'Updating Zipflow';
  if (prompt.phase === 'failed') return 'Update failed';
  if (prompt.phase === 'uncertain') return 'Update state uncertain';
  if (prompt.phase === 'complete') return 'Update installed';
  return 'Zipflow update available';
}

function updateFooter(prompt) {
  if (prompt.phase === 'installing') return prompt.cancelling ? 'Stopping safely' : 'Enter cancel · Esc cancel · Ctrl+C cancel operation';
  if (prompt.phase === 'complete') return 'Enter choose · ↑/↓ move';
  if (prompt.phase === 'uncertain') return 'Enter exit · Esc exit';
  if (prompt.phase === 'available' && prompt.installSupported === false) return 'Enter close · Esc close';
  return 'Enter choose · ↑/↓ move · Esc later';
}
