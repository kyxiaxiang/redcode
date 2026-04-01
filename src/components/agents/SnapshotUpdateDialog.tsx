import { useEffect } from 'react'

type Props = {
  agentType: string
  scope: unknown
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({ onCancel }: Props) {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return null
}
