# Contributors

BagIdea Office is built in the open. Huge thanks to everyone who has helped — by
sending a pull request, reporting an issue, or testing on a platform we couldn't.

## Maintainer

- **[@bagidea](https://github.com/bagidea)** — creator & maintainer (BagIdea Innovation Co., Ltd.)

## Community contributors

Thank you for the pull requests that made the office better — especially the
early macOS support, when the project was Windows-only:

- **[@spondanai](https://github.com/spondanai)** — macOS support & installer resilience
  ([#4](https://github.com/bagidea/bagidea-office/pull/4)), an early refactor +
  automated tests pass ([#1](https://github.com/bagidea/bagidea-office/pull/1)), and the
  macOS occlusion FPS throttle — 30→2 fps when the wallpaper is hidden
  ([#11](https://github.com/bagidea/bagidea-office/pull/11)).
- **[@misternay](https://github.com/misternay)** (Ritthikiat Jindajak) — fixed the
  CLI shell-binary finder on macOS/Linux with cross-platform tests
  ([#9](https://github.com/bagidea/bagidea-office/pull/9)), then rounded out **full
  macOS support** — installer/update robustness on a wired install, CLI uninstall,
  and a custom-provider save fix ([#12](https://github.com/bagidea/bagidea-office/pull/12)),
  and hardened TTS — surfaced failures, fixed a double-play race, escaped the speak
  JSON ([#14](https://github.com/bagidea/bagidea-office/pull/14)), and added run-lifecycle
  safety — run timeouts, graceful shutdown, and a cross-platform process-tree kill
  ([#16](https://github.com/bagidea/bagidea-office/pull/16), fixing [#15](https://github.com/bagidea/bagidea-office/issues/15)).

> Want to be on this list? Open a PR — see [docs/guide/plugin-hub.md](docs/guide/plugin-hub.md)
> for plugins, or fix anything in the repo. Every merged contribution is credited here
> and on GitHub's Contributors graph.

## Plugin authors

Submitting a plugin to the [Plugins Hub](https://bagidea.github.io/bagidea-office/plugins.html)
means opening a PR that adds your plugin to `web/plugins.json`. When we merge it
(preserving your authorship), you're credited in **three** places:

1. **GitHub Contributors graph** — your catalog PR is a commit authored by you.
2. **The Plugins page** — your plugin card shows `@your-handle` (the `author` field).
3. **This file** — we add you below.

Your plugin's own code lives in your own repo, where you're of course the author.

_(No community plugins in the catalog yet — yours could be the first!)_

## Built with Claude Code

Much of the implementation was pair-built with **Claude** (Anthropic) via Claude Code.
Commits carry a `Co-Authored-By: Claude …` trailer to credit that honestly — which is
why **Claude** appears on the Contributors graph.

---

## For maintainers — merging PRs so credit is preserved

GitHub only lists someone as a contributor when a commit **authored by them** (with a
GitHub-linked email) lands on the default branch. A squash-merge that re-authors the
commit to the maintainer **erases the contributor's credit** (this is why an earlier
merged PR didn't show up).

When merging a community PR, preserve authorship:

- **Preferred — a real merge commit** (keeps every original commit + author):
  ```bash
  gh pr merge <num> --merge
  ```
- **If you squash**, make sure the contributor is still credited — squash keeps the
  PR author as the commit author by default, but verify, and keep any
  `Co-authored-by:` trailers in the squashed message:
  ```bash
  gh pr merge <num> --squash   # then check `git log -1 --format='%an <%ae>'`
  ```
- Never hand-cherry-pick a contributor's work into a commit authored by you without a
  `Co-authored-by: Name <email>` trailer.
