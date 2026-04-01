import { useEffect } from 'react'

type Props = {
  sessions: unknown[]
  onSelect: (sessionId: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({ onCancel }: Props) {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return null
}
