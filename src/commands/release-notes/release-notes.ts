import type { LocalCommandResult } from '../../types/command.js'
import {
  CHANGELOG_URL,
  fetchAndStoreChangelog,
  getAllReleaseNotes,
  getRecentReleaseNoteGroups,
  getStoredChangelog,
} from '../../utils/releaseNotes.js'
import { getGlobalConfig } from '../../utils/config.js'

function formatReleaseNotes(notes: Array<[string, string[]]>): string {
  return notes
    .map(([version, notes]) => {
      const header = `Version ${version}:`
      const bulletPoints = notes.map(note => `· ${note}`).join('\n')
      return `${header}\n${bulletPoints}`
    })
    .join('\n\n')
}

export async function call(): Promise<LocalCommandResult> {
  // Try to fetch the latest changelog with a 500ms timeout
  let changelog = ''

  try {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(rej => rej(new Error('Timeout')), 500, reject)
    })

    await Promise.race([fetchAndStoreChangelog(), timeoutPromise])
    changelog = await getStoredChangelog()
  } catch {
    // Either fetch failed or timed out - just use cached notes
  }

  if (!changelog) {
    changelog = await getStoredChangelog()
  }

  const recentNotes = getRecentReleaseNoteGroups(
    MACRO.VERSION,
    getGlobalConfig().lastReleaseNotesSeen,
    changelog,
    3,
  )
  if (recentNotes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(recentNotes) }
  }

  const latestNotes = getAllReleaseNotes(changelog).slice(-3).reverse()
  if (latestNotes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(latestNotes) }
  }

  // Nothing available, show link
  return {
    type: 'text',
    value: `See the full changelog at: ${CHANGELOG_URL}`,
  }
}
