# Project Guidelines

## Development

- This preset uses pnpm workspaces and Turborepo. Keep executable apps under
  `apps/` and reusable packages under `packages/`.
- 使用 Node.js 22.15 或更新版本（23.x 至少 23.5），以及 pnpm 11.22 或更新版本。
- Install dependencies with `pnpm install`.
- Run `pnpm check` before submitting changes.
- Keep shared third-party versions in the pnpm catalog and internal workspace
  dependencies on `workspace:*`.
- Keep each workspace's build, lint, test, and typecheck scripts aligned with
  `turbo.json`.

## Skills

- Manage project skills with `npx skills`.
- Keep all project skills under `.agent/skills/<skill-name>/`, with each skill's
  `SKILL.md` in its directory.

## Publishing

- Use only `latest` and `rc` for new releases. Stable `<major>.<minor>.<patch>`
  versions publish to `latest`; release candidates use
  `<major>.<minor>.<patch>-rc.<N>` and publish to `rc`, starting at `rc.0` and
  incrementing the numeric index for that base version. Never publish new
  `canary`, `next`, alpha or beta versions/channels.
- Preserve historical versions, Git tags and legacy npm dist-tags unless their
  removal is explicitly authorized. Publishing an RC must not change `latest`.
- Keep repository release knowledge here, not in a project skill. See
  [README](README.md#publish-one-package) for setup and commands.
- Release one explicitly mapped package with `<package-id>-v<version>` tags.
  Never batch-publish workspaces or automatically release dependencies.
- Update the package mapping in `scripts/release-packages.js` when renaming,
  adding, or removing a publishable library. Keep the root, apps, and preset
  examples private.
- Require the tag's package identity and exact version to match both the tagged
  commit's manifest and the packed manifest, including prerelease suffixes.
- Publish only commits reachable from main with successful exact-commit main
  push CI. Keep the versioned CI aggregate and verifier arguments aligned.
- Build the selected package and its dependencies, then pack the selected
  package once with lifecycle hooks disabled. Validate and publish that same
  tarball.
- Internal runtime and peer dependencies must have matching versions already on
  npm. Publish missing dependencies separately before tagging the dependent
  package.
- Artifact verification also checks internal devDependencies. Compute release
  order from every dependency field; for example, publish Builder CLI before
  Engine even though that edge is development-only.
- A successful publish can precede registry metadata visibility. Wait for the
  exact-version lookup used by the verifier, then retry the same immutable tag;
  never move a tag or bypass dependency verification.
- Use npm Trusted Publishing, not stored tokens. Manual workflow runs are dry
  runs only. Never push release tags or publish without explicit authorization.
- Publish npm packages only through GitHub Actions
  `.github/workflows/publish-npm.yaml`, triggered by pushing an authorized
  package-specific release tag. Never run a real `npm publish` locally.
- If the Actions publish step fails authentication, check the package's npm
  Trusted Publisher binding to this repository, `publish-npm.yaml`, and the
  `npm` environment. Do not bypass it with local login or stored tokens.
- Release tags are immutable. Retry a failed pre-publication run without moving
  its tag; an existing npm version must block publication.
