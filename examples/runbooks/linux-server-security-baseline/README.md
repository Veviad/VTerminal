# Linux server security baseline

Two SSH controls, remediated by the model and graded by the engine. Run it only
against a visible Linux terminal whose administrative access you have already
confirmed.

This is the smallest useful goal-directed runbook: each step states its
condition once, under `goal`, and the engine runs that condition both to decide
whether work is needed and to decide whether the change worked. Version 1.0.0
wrote the same command twice — once as `check`, once as `verify` — which is two
places for one truth to drift.

It also shows explicit environment-to-input mapping (`VRUN_SSHD_CONFIG`),
`context.inputs` so the model can actually *see* the path its instructions refer
to, and per-step `network: false`: rewriting a local config file needs no
network, so a networked proposal is refused before it reaches an approval card.

For a larger example that adapts to the distribution it finds — firewall, Docker
and SSH across Debian, RHEL and Arch — see
[`linux-host-hardening`](../linux-host-hardening).
