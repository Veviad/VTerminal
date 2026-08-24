# Ansible localhost example

This included Runbook manages `/tmp/vterminal-ansible-example.txt` idempotently.

It runs `ansible/site.yml` through the local `ansible-runner` controller. Check and verify use Ansible check mode with diff output. Apply runs normally. Each controller invocation requires an explicit native-controller approval, and host recap outcomes are stored in the durable report.

The included inventory uses `ansible_connection=local`. For remote projects, Ansible connects through inventory SSH settings. VTerminal terminal sessions and their credentials are not reused.

Install Ansible Runner before execution: <https://ansible.readthedocs.io/projects/runner/en/latest/install/>
