# Project Guidelines

## Development

- This preset uses pnpm workspaces and Turborepo. Keep executable apps under
  `apps/` and reusable packages under `packages/`.
- Use Node.js 22.13 or newer and pnpm 11.22 or newer.
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
