# Amazon Web Services (AWS)

CloudForge Milestone 3 introduces AWS through a provider adapter that is
independent from the Oracle implementation. The first increment is deliberately
read-only: it authenticates and discovers regions, availability zones, EC2
instance types, and curated Amazon Linux/Ubuntu AMIs.

AWS instance, network, storage, and firewall mutation are not enabled yet. OCI
provisioning and management continue to use the existing Oracle adapter.

## Add AWS credentials

Open **Secrets → Add Credential → Amazon Web Services** and provide:

| Field             | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| Access Key ID     | IAM access-key identifier, normally beginning with `AKIA` or `ASIA` |
| Secret Access Key | Secret generated with the access key                                |
| Session Token     | Required only for temporary STS credentials (`ASIA…`)               |
| Default Region    | Region used for regional discovery, for example `eu-west-1`         |

Create an access key in the AWS Console under **IAM → Users → your user →
Security credentials → Create access key**. AWS shows the secret only once.
Store it immediately in CloudForge and do not commit it to the repository.

For production accounts, prefer short-lived credentials and narrowly scoped IAM
roles. Rotate long-lived access keys regularly.

## Read-only IAM policy

The discovery increment needs these EC2 read operations. `sts:GetCallerIdentity`
is used to verify the active principal and account.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudForgeDiscovery",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeImages"
      ],
      "Resource": "*"
    }
  ]
}
```

Attach the policy to the IAM principal whose access key you store. Later AWS
infrastructure phases will document separate mutation permissions; do not grant
administrator access for this discovery phase.

## Verify the connection

1. Open **Cloud Providers**.
2. Find the saved AWS credential and select **Test connection**.
3. Confirm the expected AWS account ID and default region.
4. Load **Regions**, **Availability zones**, **Instance types**, and **Images**.

If the test succeeds but a discovery action fails, the credentials are valid but
the IAM principal is missing that specific `ec2:Describe…` permission.

## Security boundaries

- AWS secrets are encrypted by the same credential service used by OCI.
- Secrets remain in the Electron main process and are never returned by provider IPC.
- Errors include the AWS request ID when available, but never include access keys.
- This increment has no AWS create, update, start, stop, terminate, or delete path.
