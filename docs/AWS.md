# Amazon Web Services (AWS)

CloudForge supports AWS through an adapter and Pulumi program isolated from the
Oracle implementation. It can authenticate, discover account resources, attach
an AWS credential to a project, Preview/Apply/Destroy an AWS plan, and manage
EC2 instance lifecycle actions.

## Add and attach AWS credentials

Open **Secrets → Add Credential → Amazon Web Services** and provide:

| Field             | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| Access Key ID     | IAM access-key identifier, normally beginning with `AKIA` or `ASIA` |
| Secret Access Key | Secret generated with the access key                                |
| Session Token     | Required only for temporary STS credentials (`ASIA…`)               |
| Default Region    | Region used for AWS operations, for example `eu-west-1`             |

Create an access key in the AWS Console under **IAM → Users → your user →
Security credentials → Create access key**. Prefer short-lived credentials and
narrowly scoped roles in production.

1. Open **Cloud Providers**, select **Test connection**, and confirm the account.
2. Open **Projects** and select the AWS credential in **Cloud provider**.
3. Open **Templates**, select the project and an SSH key, then apply **AWS EC2
   Web Server**.
4. Open **Infrastructure**, review the AWS plan, select **Save plan → Preview →
   Apply**.
5. Copy the SSH command shown after the EC2 public IP becomes available.
6. Use **Destroy** to delete the complete Pulumi-managed AWS stack and local plan.

## Provisioned resources

The AWS Pulumi adapter maps the provider-independent plan to:

- Network → VPC, internet gateway and public route table
- Public subnet → EC2 subnet and route-table association
- Firewall → security group
- Compute → EC2 instance, imported SSH key pair and gp3 boot volume
- Volume → gp3 EBS volume and optional attachment

The dedicated AWS template uses Ubuntu 24.04, `t3.micro`, a 30 GB gp3 boot
volume, and inbound ports 22, 80 and 443. These resources may incur charges.
Preview every operation and verify current AWS pricing/account eligibility.

## IAM permissions

`sts:GetCallerIdentity` verifies the principal. Discovery needs EC2 Describe
operations. Provisioning additionally needs the EC2 create/update/delete actions
for VPC, subnet, route, security-group, key-pair, instance, tag and volume
resources. A practical development policy is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudForgeEc2Management",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "ec2:CreateVpc",
        "ec2:DeleteVpc",
        "ec2:ModifyVpcAttribute",
        "ec2:CreateInternetGateway",
        "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway",
        "ec2:DeleteInternetGateway",
        "ec2:CreateRouteTable",
        "ec2:DeleteRouteTable",
        "ec2:CreateRoute",
        "ec2:ReplaceRoute",
        "ec2:AssociateRouteTable",
        "ec2:DisassociateRouteTable",
        "ec2:CreateSubnet",
        "ec2:DeleteSubnet",
        "ec2:ModifySubnetAttribute",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:ImportKeyPair",
        "ec2:DeleteKeyPair",
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:RebootInstances",
        "ec2:CreateVolume",
        "ec2:DeleteVolume",
        "ec2:AttachVolume",
        "ec2:DetachVolume",
        "ec2:CreateTags",
        "ec2:DeleteTags"
      ],
      "Resource": "*"
    }
  ]
}
```

Tighten this policy with AWS condition keys and resource tags for production.

## Safety boundaries

- AWS secrets remain encrypted and never cross renderer IPC.
- AWS and OCI resource compilers are separate modules.
- A plan/credential provider mismatch is rejected before Preview or Apply.
- Apply requires approval of the exact latest Preview.
- Pulumi preserves stable logical names and previews create/update/replace/delete.
- Errors retain AWS request IDs but never include access keys.
