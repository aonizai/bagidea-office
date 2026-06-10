# Releasing BagIdea Office

The in-app update notifier compares each user's local **`VERSION`** file with the
`VERSION` file on the **`main`** branch. Users only get a 🔄 "new version"
banner when those differ — so **a release is a deliberate `VERSION` bump on
`main`, not just any commit**.

This keeps two promises:

- Routine commits to `main` (docs, website, small fixes) never nag users.
- Users only ever update to code we've decided is ready to ship.

## Workflow

1. **Develop on `dev`** (or feature branches off `dev`). Push freely — the
   update check ignores everything except `main`'s `VERSION`, so nothing here
   reaches users.

2. **Merge to `main` when it's verified.** Merging alone does **not** trigger an
   update prompt as long as `VERSION` is unchanged. You can land several merges
   on `main` and still hold the release.

3. **Cut a release** when you're confident it's bug-free:
   - Bump `VERSION` (semver — `MAJOR.MINOR.PATCH`).
   - Commit + push to `main`.
   - Within ~6 h (or 90 s after a restart) every running office sees the newer
     `VERSION`, shows the 🔄 banner, and `bagidea update` pulls + rebuilds +
     relaunches.

## Versioning (semver)

- **PATCH** (`0.1.0 → 0.1.1`): bug fixes, copy, no behaviour change for users.
- **MINOR** (`0.1.0 → 0.2.0`): new features, backward compatible.
- **MAJOR** (`0.1.0 → 1.0.0`): breaking changes (data format, removed commands).

## Checklist before bumping VERSION

- [ ] `dev` merged to `main`, working tree clean.
- [ ] Automated tests pass: `node --test daemon/tests/api.test.js`.
- [ ] Daemon boots clean: `node daemon/server.js` (no errors), or `bagidea restart`.
- [ ] Shell builds: `cargo build --release` in `shell/`.
- [ ] Godot scene loads: `godot/bin/BagIdeaOffice.exe --headless --check-only --quit`
      (only "leaked at exit" RID lines are fine — no `SCRIPT ERROR` / `Parse Error`).
- [ ] Docs/README reflect the changes.
- [ ] Bump `VERSION`, commit `release: vX.Y.Z`, push `main`.
