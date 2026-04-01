// The published snapshot is missing the bundled verify markdown assets.
// Keep the module shape intact with minimal placeholder content so the CLI
// can build and the feature can fail gracefully if reached.

export const SKILL_MD = `# Verify

This reconstructed source snapshot does not include the original bundled
verify skill content.
`

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': '# Verify CLI example\n\nUnavailable in this snapshot.\n',
  'examples/server.md':
    '# Verify server example\n\nUnavailable in this snapshot.\n',
}
