import { join } from 'path'

export function codexSkillInstructions(appPath: string): string {
  const skills = join(appPath, 'electron', 'skills')
  const skillFile = (name: string) => JSON.stringify(join(skills, name, 'SKILL.md'))

  return [
    `When working on the project open in Kadr, read ${skillFile('kadr-editor')} and follow its editing and verification guidance.`,
    `For music or beat-synced edits, also read ${skillFile('kadr-music')}.`,
    `For titles, captions, Remotion fragments, or motion graphics, also read ${skillFile('kadr-motion')}.`,
    `For 3D work, also read ${skillFile('kadr-3d')}.`,
    'Consult the reference files linked from those skills as needed, resolving their paths relative to the skill file.',
    'Inspect PNG snapshots and contact sheets returned by Kadr with your image-viewing tool.',
    'For the critic procedure in those skills, use the Kadr MCP tool kadr_review. Pass the exact range in timeline seconds and the relevant requirements in the user’s own words. Follow the returned next step and the skill’s review and verification limits.'
  ].join('\n')
}
