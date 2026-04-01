import type { Command } from '../../types/command.js';

const freeCommand: Command = {
  type: 'local',
  name: 'free',
  description: 'Enable free AI channel via embedded proxy',
  isHidden: false,
  supportsNonInteractive: false,
  load: () => import('./free.js'),
};

export default freeCommand;
