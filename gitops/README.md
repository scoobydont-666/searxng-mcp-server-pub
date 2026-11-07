# Revision-pinned Flux delivery

`scripts/prepare_gitops.py` builds a delivery unit from a **clean checkout of the
exact reviewed source commit**. It renders the local Helm chart with the selected
values, then writes a directory to be committed to your deployment repository:

| File | Role |
| --- | --- |
| `delivery.yaml` | Three objects, described below. |
| `kustomization.yaml` | Lists `delivery.yaml` so a Flux `Kustomization` can apply the directory. |

`delivery.yaml` contains:

| Object | Role |
| --- | --- |
| `Namespace` | Dedicated application namespace with restricted Pod Security labels. |
| `GitRepository` (`source.toolkit.fluxcd.io/v1`) | Operator-supplied repository URL, pinned to a full commit SHA, with an optional existing source credential Secret. |
| `HelmRelease` (`helm.toolkit.fluxcd.io/v2`) | The chart at that revision, embedded nonsecret values, a required namespace-scoped `serviceAccountName`, revision-based reconciliation, explicit target/storage namespace, and bounded remediation. |

The HelmRelease is **suspended by default**. Its source may reconcile while the
release is suspended, but the application workload is not installed. Preparing a
bundle is a local action; applying it requires an explicitly chosen cluster and
the established deployment authority. Flux owns the Helm release once active;
Ansible reconciles only this delivery unit.

The tooling does not install Flux, bootstrap Kubernetes, provision a datastore,
create credentials, or issue certificates. Complete the
[operator prerequisites](../docs/operations.md) first. Required chart inputs,
including the real application image digest and HA endpoint CIDRs, must be
provided even for a suspended review bundle.

## Deployment repository is the record (required)

The embedded values are the production configuration. A bundle that exists only in
`artifacts/`, on a workstation, or in the cluster is not an auditable record, and
Flux cannot detect drift from it. Therefore:

- Commit the bundle directory (`delivery.yaml` and `kustomization.yaml`) to your
  deployment repository. Review each change to it as a configuration change.
- Apply it through **one** desired-state owner: a Flux `Kustomization` that points
  at the committed directory, or the Ansible bootstrap run from a clean committed
  checkout of that repository. Do not let both own the same objects.
- The deployment `GitRepository` must reference either a pinned full `ref.commit`
  that you advance per promotion, or a branch protected by required review.
- The Ansible bootstrap reads `delivery.yaml` from the working tree. Run it only
  when `git -C "$SEARXNG_DEPLOY_DIR" status --porcelain` is empty.

Example, for a deployment repository whose `searxng/` directory receives the bundle
(replace the example values):

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: searxng-deployment
  namespace: flux-system
spec:
  interval: 10m
  url: https://git.example.invalid/example-org/searxng-deployment.git
  ref:
    branch: main  # or: commit: <reviewed full 40-character SHA>
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: searxng-delivery
  namespace: flux-system
spec:
  interval: 10m
  path: ./searxng
  prune: false  # Removing a Namespace from Git deletes its Secrets and volumes.
  serviceAccountName: searxng-kustomizer
  sourceRef:
    kind: GitRepository
    name: searxng-deployment
```

`searxng-kustomizer` needs only the rights the bundle uses: `create`, `get`, `list`,
`watch`, and `patch` on the `Namespace` cluster resource, plus the same verbs on
`GitRepository` and `HelmRelease` in `flux-system`. Do not bind `cluster-admin`.

## Service account and RBAC (required)

`--service-account` is required. It sets `HelmRelease.spec.serviceAccountName`, and
helm-controller impersonates that ServiceAccount in `flux-system`, the HelmRelease
namespace. The bundle does not create it. Provide it, then grant it rights only
inside the application namespace. Example for namespace `searxng` and
ServiceAccount `searxng-deployer`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: searxng-deployer
  namespace: flux-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: searxng-helm-deployer
  namespace: searxng
rules:
  - apiGroups: [""]
    resources: [configmaps, persistentvolumeclaims, pods, resourcequotas, secrets, serviceaccounts, services]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [apps]
    resources: [deployments, replicasets, statefulsets]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses, networkpolicies]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [monitoring.coreos.com]
    resources: [prometheusrules, servicemonitors]
    verbs: [get, list, watch, create, update, patch, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: searxng-helm-deployer
  namespace: searxng
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: searxng-helm-deployer
subjects:
  - kind: ServiceAccount
    name: searxng-deployer
    namespace: flux-system
```

Helm stores release history as Secrets in the target namespace, so the role must
write Secrets there. Keep that namespace limited to this release. Do not add
cluster-scoped rights to this ServiceAccount.

## Inputs and source identity

Set the following operator inputs for the selected environment:

| Input | Meaning |
| --- | --- |
| `SEARXNG_SOURCE_URL` | Independently approved source URL: `https://<host>/<owner>/<repo>.git` or `ssh://git@<host>/<owner>/<repo>.git`. Credentials, query strings, and fragments are rejected. |
| `SEARXNG_GIT_SECRET` | Existing Secret in `flux-system`. Required for SSH/private access; leave empty for unauthenticated public HTTPS. |
| `SEARXNG_SERVICE_ACCOUNT` | Existing namespace-scoped ServiceAccount in `flux-system` with the RBAC above. Required. |
| `SEARXNG_DEPLOY_DIR` | Directory inside your clean deployment repository checkout that receives `delivery.yaml` and `kustomization.yaml`. |
| `SEARXNG_CONTEXT` | The exact kube context chosen by the operator. |
| `SEARXNG_EXPECTED_SERVER` | Independently verified HTTPS API-server URL for that context. |
| `SEARXNG_NAMESPACE` | Dedicated namespace, default below `searxng`. |
| `SEARXNG_RELEASE` | Release/source object name, default below `searxng-platform`. |

For SSH, use a read-only deploy key and independently verified host keys. Source
credentials belong in the referenced Secret, not in the URL. Application image
pull credentials are a separate Secret in the application namespace. See the
[source/registry setup](../docs/operations.md#separate-source-and-registry-access).

The source commit must already be available in the configured remote repository
when Flux fetches it. A successful local render does not establish remote
availability, image existence, Secret contents, or cluster readiness.

## Prepare a suspended review bundle

Run these commands from the repository root in a clean checkout of the reviewed
revision. Populate `site-values.local.yaml` from the
[site template](../examples/site-values.yaml.example), with the real image
repository/digest and site prerequisites. Local `*.local.yaml` files and the
`artifacts/` directory are ignored so they do not make the source checkout dirty.
The site values are embedded in `delivery.yaml`, so commit the generated bundle to
the deployment repository as described above.

```bash
: "${SEARXNG_SOURCE_URL:?Set the reviewed source repository URL}"
: "${SEARXNG_SERVICE_ACCOUNT:?Set the namespace-scoped ServiceAccount in flux-system}"
: "${SEARXNG_DEPLOY_DIR:?Set the bundle directory inside the deployment repository}"
SEARXNG_NAMESPACE=${SEARXNG_NAMESPACE:-searxng}
SEARXNG_RELEASE=${SEARXNG_RELEASE:-searxng-platform}
SEARXNG_REVISION=$(git rev-parse HEAD)

searxng_delivery_args=(
  --revision "$SEARXNG_REVISION"
  --repository-url "$SEARXNG_SOURCE_URL"
  --namespace "$SEARXNG_NAMESPACE"
  --release "$SEARXNG_RELEASE"
  --git-secret "${SEARXNG_GIT_SECRET:-}"
  --service-account "$SEARXNG_SERVICE_ACCOUNT"
  --values examples/values-all-engines-secure.yaml
  --values site-values.local.yaml
)

python3 scripts/prepare_gitops.py "${searxng_delivery_args[@]}" \
  --output-dir "$SEARXNG_DEPLOY_DIR"

python3 scripts/validate_delivery.py "$SEARXNG_DEPLOY_DIR/delivery.yaml" \
  --expected-repository-url "$SEARXNG_SOURCE_URL"
```

For the baseline broad-engine configuration, replace the values portion with
`--values environments/lab.yaml --values examples/values-all-engines.yaml` and
then the site values. A machine-only site must also select its intended browser,
ingress, datastore, and monitoring switches explicitly; the site template is
written for the hardened example. Enterprise 3k/5k profiles are selectable in the
same order. Maps merge recursively; later scalars and lists replace earlier ones.
The hardened example already includes the complete enterprise-5k planning profile.

The source guard rejects any dirty tracked/untracked work or a revision that does
not equal `git rev-parse HEAD`. Commit and review source changes before preparing
their delivery. The script never uses an abbreviated SHA or a moving branch/tag
as the Flux reference. Change the source pin to advance a release.

`validate_delivery.py` requires the expected repository URL independently of the
bundle. It accepts only the exact generated fields and ownership labels, requires
`spec.serviceAccountName` and rejects `default`, checks the chart path/source
reference and namespaces, and rejects injected resources, `postRenderers`, and
`valuesFrom`. Add `--context "$SEARXNG_CONTEXT"` for a read-only ownership check of
existing objects. An ownership conflict requires a distinct release/namespace or a
separately reviewed migration. Bundles generated before `serviceAccountName` was
required must be regenerated.

## Preview and apply the suspended unit

Record the operator's target independently of the bundle. This command prepares
only a local nonsecret Ansible variable file with an absolute delivery path:

```bash
: "${SEARXNG_CONTEXT:?Set the intended kube context}"
: "${SEARXNG_EXPECTED_SERVER:?Set the independently verified HTTPS API-server URL}"
export SEARXNG_CONTEXT SEARXNG_EXPECTED_SERVER SEARXNG_SOURCE_URL SEARXNG_DEPLOY_DIR

test -z "$(git -C "$SEARXNG_DEPLOY_DIR" status --porcelain)"

python3 - <<'PY'
import os
from pathlib import Path
import yaml

settings = {
    "searxng_delivery_file": str(Path(os.environ["SEARXNG_DEPLOY_DIR"], "delivery.yaml").resolve()),
    "searxng_kube_context": os.environ["SEARXNG_CONTEXT"],
    "searxng_expected_server": os.environ["SEARXNG_EXPECTED_SERVER"],
    "searxng_expected_repository_url": os.environ["SEARXNG_SOURCE_URL"],
}
Path("bootstrap.local.yaml").write_text(yaml.safe_dump(settings, sort_keys=False))
PY

ansible-playbook -i localhost, ansible/bootstrap.yml \
  --check --diff --extra-vars @bootstrap.local.yaml
```

Check mode reads the selected API server identity, validates existing ownership,
and asks Kubernetes for a server-side diff. It does not apply the bundle. The
playbook treats the normal `kubectl diff` exit code 1 as a difference and other
unexpected nonzero codes as failures. Inspect the actual target and diff.

When installation of the reviewed suspended unit is authorized:

```bash
ansible-playbook -i localhost, ansible/bootstrap.yml \
  --diff --extra-vars @bootstrap.local.yaml
```

This creates the dedicated namespace and Flux objects. The workload remains
suspended. Reconcile application Secrets, source/image credentials, TLS, and
optional operator prerequisites through their own approved workflow. Those
resources are intentionally separate from the validated three-object unit.

If the deployment repository's Flux `Kustomization` owns these objects instead,
skip the Ansible apply and let that Kustomization apply the committed bundle.

## Activate the reviewed revision

After prerequisite readiness and the intended rollout window are established,
generate active intent with the **same** source, values, and service account
arguments, writing to the same deployment directory:

```bash
python3 scripts/prepare_gitops.py "${searxng_delivery_args[@]}" \
  --active --output-dir "$SEARXNG_DEPLOY_DIR"

python3 scripts/validate_delivery.py "$SEARXNG_DEPLOY_DIR/delivery.yaml" \
  --expected-repository-url "$SEARXNG_SOURCE_URL" \
  --context "$SEARXNG_CONTEXT"
```

Review the change in the deployment repository. Relative to the committed review
bundle, only `HelmRelease.spec.suspend` should change. Commit it through that
repository's review process, then apply it through the same desired-state owner
used for the review bundle. Rerunning the Ansible check/diff command reads the same
`delivery.yaml` path and shows the activation diff; apply it without `--check` only
after review.

A repository promotion may activate the service immediately, so review `suspend`
and the target before that promotion.

Read-only status checks after activation:

```bash
kubectl --context "$SEARXNG_CONTEXT" --namespace flux-system \
  get gitrepository "$SEARXNG_RELEASE"
kubectl --context "$SEARXNG_CONTEXT" --namespace flux-system \
  get helmrelease "$SEARXNG_RELEASE"
kubectl --context "$SEARXNG_CONTEXT" --namespace "$SEARXNG_NAMESPACE" \
  get deployments,pods,hpa,pdb
```

Then verify the reconciled source, image/config/secret revisions, policy behavior,
and actual search/authentication transactions described in the
[operations guide](../docs/operations.md#6-verify-the-installed-service-before-moving-traffic).
Neither `Ready=True` nor a successful Helm operation proves provider quality or
the 3,000–5,000-user capacity target.

## Upgrade, repeat, and recover

An upgrade is a new reviewed source/image/configuration decision. Generate the
bundle from that clean revision, commit it to the deployment repository, and use
the same preview/promotion path. A Secret rotation also increments
`secrets.revision`. Template output has no generated timestamps, random secret
bytes, or cluster lookups; unchanged desired state should not restart healthy
pods or regenerate credentials.

Keep a known-good bundle and its immutable image available. For a functional
rollback, prepare active intent from the earlier source revision and its saved
compatible values, validate/diff it against the same target, and promote it
through the current owner. Secret revocation, external datastore changes, and
provider-side configuration are not undone by Helm. Preserve the compatible
current credential state or plan a controlled repair before reverting software.

The generated HelmRelease uses one remediation retry and upgrade rollback
strategy. The controller's behavior is defined by the installed
[Flux HelmRelease API](https://fluxcd.io/flux/components/helm/helmreleases/).
Operator recovery must still validate the resulting user transaction and update
the desired-state record; a transient manual Helm rollback is not the normal
recovery path.
