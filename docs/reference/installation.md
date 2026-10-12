# Customer installation preflight

The supported target is a dedicated installation in the customer's AWS account on an
existing EKS environment. [Organization installation](../deploying-for-your-org.md) owns
the apply/build/acceptance sequence; [IaC](iac.md) owns inputs and resource lookups.
The customer boundary is defined in [ADR-019](../decisions/ADR-019-dedicated-installation-identity.md).

## Read-only checks

Use Python >=3.9, authenticated AWS CLI and `kubectl` from a machine with target API access.
Supply the expected customer account and exact context explicitly:

```bash
python3 scripts/install-preflight.py \
  --account-id YOUR_12_DIGIT_CUSTOMER_ACCOUNT \
  --region YOUR_REGION --cluster YOUR_CLUSTER \
  --context YOUR_KUBECTL_CONTEXT --domain example.com \
  --node-role YOUR_EXISTING_NODE_ROLE \
  --subnet-id subnet-00000000000000001 \
  --subnet-id subnet-00000000000000002 \
  --record /tmp/dashboard-install-preflight.json
```

Keep target inputs consistent with Terraform. Omit explicit role/subnets only when using
the legacy role pattern and discovery tags. The script reads STS, EKS, IAM, EC2, Route53,
ACM and Kubernetes metadata. It creates no cloud resources, changes no kube context, reads
no Kubernetes Secrets and does not invoke a model. Read permissions and network access
are required; a denied/unreachable/invalid response is `unavailable`, never a pass.

Exit 0 means automated checks passed; 1 means a failed/unavailable check; 2 means invalid
inputs or a report-write failure. A wrong AWS account stops before cluster queries. A
wrong kube endpoint skips Kubernetes probes. Each CLI invocation has a 20-second timeout.
CLI stderr/raw metadata are suppressed. The optional new report is mode 0600 and cannot
overwrite an existing file. It records timestamp, script hash, requested non-secret target
inputs and check states; keep it private and outside version control.
The report uses a complete private temporary file and an atomic exclusive hard link in
the same directory; the filesystem must support hard links. Write failure leaves no partial
destination. Console check states remain visible even when report publication fails.

## Interpretation and remaining verification

Checks cover account/cluster/context, served CRD versions, storage/CSI registration,
ready controller image hints, IRSA OIDC-provider presence, subnet lookup/no automatic
public IP/available addresses, node-role lookup, public zone and wildcard certificate.
The certificate query mirrors Terraform's primary-domain/ISSUED/default RSA-2048 lookup
in `us-east-1`; it does not broaden accepted key types. Independently verify the selected
certificate's trust/expiry and CloudFront eligibility before apply.

The controller hint accepts a separate Keeper operator or the verified combined
`altinity/clickhouse-operator:0.26.2` image (optionally digest-pinned). Its
[official source](https://github.com/Altinity/clickhouse-operator/blob/0.26.2/cmd/operator/app/thread_keeper.go)
registers the Keeper controller. Other combined versions or repackaged images need
independent verification; an image hint does not prove that controller is active. A served CRD
does not establish a healthy operator; a StorageClass does not prove volume provisioning.
No automatic public IP does not prove a private subnet: independently inspect effective
routes, addresses, security groups, DNS and service reachability. IAM lookup does not prove
node admission or Karpenter authorization. The report lists these manual gates.

Also verify state ownership, service quotas, VPC-origin eligibility, real IdP/role login,
external secrets, collector transport, migration/retention, backup/isolated restore and
the installed data path. Follow [product acceptance](../product-readiness.md); automated
preflight success is neither deployment nor commercial-release approval.
