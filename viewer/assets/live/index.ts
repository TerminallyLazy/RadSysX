import { LiveController } from './controller.js';
import { OHIFAdapter, type Managers } from './ohif.js';
import { registerPanel } from './panel.js';

const adapter = new OHIFAdapter();
const controller = new LiveController(adapter);
// The extension owns manager lifetimes; the controller survives panel remounts only.
const bind = () => {
  const managers = (window as any).__RADSYSX_OHIF_MANAGERS__ as Managers | undefined;
  if (managers) adapter.bind(managers);
};
window.addEventListener('radsysx-ohif-ready', bind); bind();
window.addEventListener('radsysx-ohif-exit', () => { if (controller.session) void controller.end(); });
registerPanel(controller);
