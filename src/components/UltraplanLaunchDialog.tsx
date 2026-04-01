import React from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { CCR_TERMS_URL } from '../commands/ultraplan.js'

type UltraplanLaunchChoice = 'launch' | 'cancel'

type Props = {
  onChoice: (
    choice: UltraplanLaunchChoice,
    opts?: { disconnectedBridge?: boolean },
  ) => void
}

export function UltraplanLaunchDialog({ onChoice }: Props): React.ReactNode {
  return (
    <Dialog
      title="Launch ultraplan?"
      onCancel={() => onChoice('cancel')}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          This will start a remote Claude Code session on the web to draft an
          advanced plan using Opus. The plan typically takes 10–30 minutes.
          Your terminal stays free while it works.
        </Text>
        <Text dimColor>Terms: {CCR_TERMS_URL}</Text>
      </Box>
      <Select
        options={[
          {
            value: 'launch' as const,
            label: 'Launch ultraplan',
          },
          {
            value: 'cancel' as const,
            label: 'Cancel',
          },
        ]}
        onChange={(value: UltraplanLaunchChoice) => onChoice(value)}
      />
    </Dialog>
  )
}
