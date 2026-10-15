/**
 * The project a launch asks to open: the last argument naming a .kadr file.
 * Switches (`--x=…`) are never files; the executable and the app folder are not
 * .kadr, so they fall out on their own. Test: scripts/check-argv-project.mjs
 */
export function argvProject(argv: readonly string[] | undefined): string | null {
  const hit = (argv ?? []).filter((a) => !a.startsWith('-') && /\.kadr$/i.test(a)).pop()
  return hit ?? null
}
