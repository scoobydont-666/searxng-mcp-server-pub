# Public-source preparation and publication boundary

The public candidate is prepared from the fully sanitized, committed source tree.
It receives fresh Git history and an anonymous project identity. Preparing the
candidate or a review bundle does not publish a repository, authorize a license,
approve the change, or deploy the application.

## Sanitize and review the committed tree

Remove private identifiers, environment addresses, credentials, local operational
records, and generated artifacts in the source checkout before committing the
candidate. Keep public examples generic and required operator inputs empty. Use
`scripts/check_publication.py` to inspect tracked paths/content; an optional local
private-pattern file can extend the check without being committed. Findings must
identify locations without copying sensitive contents into logs or review text.

Review the complete intended source commit, including executable examples,
workflow permissions, image/configuration defaults, dependencies, provenance,
and licensing. Run the repository's runtime and infrastructure checks. Static
sanitizer output is one check, not proof that a human review is unnecessary.

The application is licensed under the MIT License (`LICENSE`), as selected by the
rights holder. That license covers this repository's own work only; retained
third-party notices and license obligations remain separate (see `NOTICE`). Until
the independent reviews of the exact export are complete, keep the candidate
repository and its bundle private.

## Produce a fresh repository and optional bundle

From the exact clean, committed source checkout:

```bash
python3 scripts/check_publication.py
python3 scripts/export_public.py \
  --output ../searxng-mcp-server-pub \
  --bundle ../searxng-mcp-server-pub.bundle
```

The output directory must be new, outside the source checkout, and have a basename
ending in `-pub`. Its parent directory must already exist. The optional bundle
must also be a new path outside **both** repositories. Existing files/directories
are never overwritten.

The exporter permits only approved tracked source paths and reads their committed
Git blob bytes. Ignored files such as dependencies, compiled output, credentials,
and local artifacts are never copied. A tracked forbidden path, symlink,
submodule, unmerged entry, or dirty source makes the export fail; nothing is
silently removed to make the result appear clean.

The exported tree must have the exact same Git tree ID as the source `HEAD` tree,
including executable modes. This equality is why the **source tree itself must
already be sanitized**. The exporter creates a new `main` branch with exactly one
root commit attributed to `SearXNG Platform Contributors
<contributors@example.invalid>`. It copies no source history, remotes, tags,
commit messages, author identities, or original commit timestamps. It runs the
publication gate again against the export, including its fresh history. The
optional bundle contains only the new `main` history.

To inspect or hand off that bundle privately:

```bash
git bundle verify ../searxng-mcp-server-pub.bundle
git clone --branch main ../searxng-mcp-server-pub.bundle ../searxng-public-review
```

The bundle is a complete source handoff and may itself contain material awaiting
licensing/review. Store and share it with the same private-review access controls
as the candidate repository. A bundle does not transfer an original repository's
access permissions or its hosted review records.

## Two independent review receipts

Have two independent reviewers inspect the actual exported commit and its diff
against the approved sanitized source. Record each reviewer's identity, reviewed
export commit SHA, scope, findings, verdict, and a durable review reference in the
private review system. The author/exporter's self-check is not an independent
review. Do not fabricate receipts or carry approvals to a changed commit without
reviewing the changed scope.

One review should emphasize functionality and operations; the other should
emphasize security, privacy, dependency/licensing obligations, and publication
metadata. Both reviewers remain responsible for the whole candidate. Any
post-export edit changes the review subject: commit it through the same private
process, rerun relevant checks, and obtain the required updated reviews.

## Create a private hosted review repository

Only after choosing the actual destination owner and obtaining repository-creation
authority, an operator with GitHub CLI access can create the separate review
repository. Set `SEARXNG_PUBLIC_OWNER` to that owner; this command explicitly keeps
the destination **private**:

```bash
: "${SEARXNG_PUBLIC_OWNER:?Set the approved destination owner}"
gh repo create "${SEARXNG_PUBLIC_OWNER}/searxng-mcp-server-pub" \
  --private --source ../searxng-mcp-server-pub --remote origin --push
```

Inspect the created repository's visibility, pushed `main` SHA, and absence of
unexpected refs. A source-only review branch or a bundle stored in an existing
private repository is a useful handoff when repository creation is unavailable;
it is not evidence that the separate destination has been created or published.

Changing visibility to public is a separate release action after the licensing
decision, two valid review receipts, final sanitization/history checks, and the
owner's publication authorization. This guide does not perform that action.
Report separately whether the candidate was exported, privately hosted,
independently reviewed, licensed for distribution, publicly published, or deployed.
