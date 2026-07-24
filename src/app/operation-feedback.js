import { translateForState as t } from '../i18n/index.js';

export function showOperationBusy(controller, error) {
  const active = controller.state.activeOperation?.label || error?.activeOperation || 'another operation';
  controller.toast(
    'Another operation is still running',
    'warning',
    4,
    t(controller.state, 'Wait for {operation} to finish or cancel it first.', { operation: active }),
  );
  controller.setStatus(`${active} is still running`);
  return true;
}
