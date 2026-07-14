# First OCI instance and safe deletion

This walkthrough uses only CloudForge after the one-time installation of Pulumi and the OCI API
credential. Oracle Console is not required for normal provisioning or deletion.

## Provision from the application

1. Open **Secrets**, add an Oracle credential, and confirm that its API key has permission to
   manage compute, volumes, and virtual networking in the selected compartment.
2. Open **SSH Keys** and generate or import a key pair. CloudForge encrypts the
   private key and exposes the public half for instance plans.
3. Open **Projects**, create the project, select the Oracle credential, region, and environment.
4. Open **Templates**, select the SSH key, and apply **OCI Always Free ARM VPS**.
   It seeds a VCN, public subnet, TCP 22/80/443 firewall, and
   `VM.Standard.A1.Flex` with 4 OCPUs, 24 GB RAM, a 200 GB boot disk, and Ubuntu
   24.04 ARM64. Open **Infrastructure** afterward to customize it before Apply.
5. Open TCP 22 for SSH. Add 80 and 443 only when the server will host HTTP/HTTPS services.
6. For the compute resource, select the public subnet, enable **Assign public IP**, choose the
   shape and image, paste the SSH public key, and set the boot-volume size.
7. Select **Save plan**, then **Preview**. Review all create, update, replacement, and delete
   operations before continuing.
8. Select **Apply**. Wait for success, then copy the public IP from **Stack outputs**.
9. Stack outputs include the public/private IP and SSH user. Connect with
   `ubuntu` for this template (`opc` for Oracle Linux).

## Where the SSH user, key, and password come from

- CloudForge generates or imports the **key pair before provisioning**. The plan
  sends only the public key to OCI as `ssh_authorized_keys`; the encrypted
  private key never enters the plan, OCI, or the server.
- The **user belongs to the image**, not the plan: Ubuntu uses `ubuntu`; Oracle
  Linux uses `opc`. CloudForge publishes it as the `<instance-name>SshUser`
  stack output.
- Standard OCI platform images do **not give CloudForge an SSH password**. Use
  key authentication. SSH Password credentials are for existing VPSs where you
  separately enabled password login; CloudForge cannot discover that password.
- In **Ansible**, choose the key credential, public IP and `ubuntu`; inspect and
  independently verify the host fingerprint, save the target, then preflight it.

```powershell
ssh -i "$HOME\.ssh\my-cloudforge-key" ubuntu@<stack-public-ip>
```

Always Free is a tenancy-wide allowance target, not a promise of regional
capacity or zero cost. Review Preview and OCI usage when other A1 instances or
boot volumes already consume the allowance.

## Understand the creation progress

CloudForge does not display a fabricated percentage. While Preview, Apply or
Destroy is running, an indeterminate progress panel listens to Pulumi's
structured engine events and shows real operations such as:

```text
Preparing infrastructure engine
Creating Vcn “network”
Vcn “network” ready
Creating Instance “hanoutplus-server”
Instance “hanoutplus-server” ready
Infrastructure ready in 2m 15s
```

A failed resource is marked **Failed** and the final operation cannot become
**Ready** after a failure. The OCI provider waits for the cloud operation before
Pulumi emits resource completion. If the app is interrupted, stale deployment
records are reconciled to **Failed** at the next startup instead of remaining stuck.

## HanoutPlusApp created on this workstation

- Project: `HanoutPlusApp`
- Stack: `hanoutplusapp-58db3cfe/development`
- Region: `af-casablanca-1`
- Instance: `hanoutplus-server`
- Shape: `VM.Standard.A1.Flex` (1 OCPU, 6 GB RAM)
- Image: Oracle Linux 9.7 ARM
- Boot volume: 50 GB
- Firewall ingress: TCP 22, 80, and 443
- SSH credential in CloudForge: `HanoutPlus SSH RSA`
- Local private key: `C:\Users\abder\.ssh\cloudforge_hanoutplus_rsa`

Connect from PowerShell:

```powershell
ssh -i "$HOME\.ssh\cloudforge_hanoutplus_rsa" opc@51.170.132.115
```

## Delete resources safely

There are two resource views:

- **Infrastructure → Managed Cloud Stacks** shows Pulumi stacks and every resource CloudForge
  tracks. Use **Destroy stack** to delete a managed instance together with its VCN, subnet,
  route table, gateway, security list, and boot volume in dependency-safe order.
- **Cloud Providers → Test connection → Load instances** discovers active account instances,
  including servers created outside CloudForge. Select **Terminate**, then type the exact instance
  name. This permanently terminates the instance and deletes its boot volume.

Prefer **Destroy stack** for a CloudForge-managed server. Direct account termination is intended
for untracked/legacy instances; deleting a managed instance there creates stack drift until the
next refresh/apply.

CloudForge blocks project deletion while its managed stack still contains resources. Destroy the
stack first, verify the result, and only then delete the project record.

## Security notes

- Cloud operations are authenticated by the OCI API key, not by an Oracle Console password.
- CloudForge requires the exact resource or instance name for destructive confirmation and records
  the action in the activity log.
- Rotate any password that was pasted into chat, logs, source files, or screenshots. Do not reuse it
  as an application deletion password.
