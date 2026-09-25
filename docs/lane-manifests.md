# Lane manifest examples

The files in [`examples/lanes`](../examples/lanes) provide three example lanes
as worker configurations that Pi 0.85.1 can load:

| Lane          | Worker manifest      | Catalog config                      | Distinguishing choice                                     |
| ------------- | -------------------- | ----------------------------------- | --------------------------------------------------------- |
| Static        | `static.json`        | `static.catalog-config.json`        | SoL model, fixed local extensions                         |
| Adaptive      | `adaptive.json`      | `adaptive.catalog-config.json`      | SoL model, plus an experimental SoL-Pi candidate          |
| Smaller model | `smaller-model.json` | `smaller-model.catalog-config.json` | Luna model with the same fixed local extensions as static |

Each worker manifest validates against the closed `fm-worker-config/v1`
schema. Catalog settings live in a separate file because that schema rejects
unknown fields. A future worker-config v2 can add a catalog reference, but that requires a
schema change.

## Run an example without network access

The checked-in catalog uses inert extensions from `stand-ins/`. The source
commit is intentionally a placeholder because a committed file cannot contain
the hash of the commit that contains it. `prepare-catalog.ts` copies those
files into a temporary Git checkout, pins the resulting commit, and rewrites
the catalog digest in a generated config. It does not fetch or install
anything.

```sh
fixture_dir="$(mktemp -d)"
catalog_config="$(node examples/lanes/prepare-catalog.ts static "$fixture_dir")"

PI_WORKER_MANIFEST=examples/lanes/static.json \
PI_EXTENSION_CATALOG_CONFIG="$catalog_config" \
pi -e ./src/extension.ts
```

Use `adaptive` or `smaller-model` in place of `static` for the other examples.
The adaptive lane refuses `sol-pi` by default with
`experimental-opt-in-required`. Pass the extension ID to the preparation
script to opt in:

```sh
fixture_dir="$(mktemp -d)"
catalog_config="$(node examples/lanes/prepare-catalog.ts adaptive "$fixture_dir" sol-pi)"

PI_WORKER_MANIFEST=examples/lanes/adaptive.json \
PI_EXTENSION_CATALOG_CONFIG="$catalog_config" \
pi -e ./src/extension.ts
```

The examples write selection receipts below `.pi/receipts/` in Pi's Git root.
The receipt records `pi-typesafe` as `already-loaded`, `lane-core` as `loaded`,
and the adaptive `sol-pi` decision as either `refused` with its reason or
`loaded` after opt-in.

## Worker manifest fields

`identity` binds the file to one task and lane. Replace `brief_sha256` with the
digest of the task brief for each dispatch.

`runtime` pins Pi 0.85.1 and records the worker launch settings. The catalog
has an exact compatibility row for this version.

`bounds` is the authority boundary. The model, tools, extensions, hooks, and
Jev budgets are maximums, not suggestions. The adaptive example allows
`sol-pi`; the other two do not. The static and smaller-model examples set the
Jev selection budget to zero, as in the corresponding source configurations.

`selection` is the deterministic fallback and the initial runtime choice. All
selected values must occur in their matching bound. Static and adaptive use
`openai-codex/gpt-5.6-sol`; the smaller-model arm uses
`openai-codex/gpt-5.6-luna`. Provider-qualified names match Pi's runtime model
references.

`domains` states who owns each mutable setting, how Pi reloads it, and the
expected cache effect. These values come from the worker-config schema and are
the same in all three examples.

`rollback_target` identifies the configuration and worktree commit to restore
for rollback. The example values are placeholders. Replace both before
deploying the configuration.

`receipts` is a normalized path relative to the worker's Git root.
`provenance` records why the example configuration was created. `integrity`
contains the canonical self-hash and the worker-config validator identity. Any
edit requires recalculating `integrity.self_sha256`.

Run the repository's offline checks after changing the manifests. They exercise
all three examples through Pi's loader and validate their schema and integrity:

```sh
npm run check
```

## Catalog config fields

Set `PI_EXTENSION_CATALOG_CONFIG` to an absolute path or a path relative to
Pi's working directory. The loader accepts only
`pi-extension-catalog-config/v1` with one `catalog` object.

`catalog.path` names the catalog JSON file. `catalog.sha256` pins its canonical
digest. `catalog.artifacts` maps selected extension IDs to clean local Git
checkouts. Paths in both fields resolve from the catalog-config directory.
Every checkout must match the catalog's repository URL and exact commit, and
every listed file hash must match before Pi imports an entry point.

`catalog.experimental_opt_in` is the explicit gate for experimental entries.
An empty list is the safe default. Proposed entries never load, and
implemented entries still need compatible Pi evidence and satisfied
prerequisites.

The catalog loader never downloads an artifact. A bad config, digest, source,
hash, compatibility row, or prerequisite refuses the affected load and leaves
the Pi session running. The selection receipt carries the typed refusal reason.
