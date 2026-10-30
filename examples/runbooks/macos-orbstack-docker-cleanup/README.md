# macOS OrbStack Docker Cleanup

Import this folder into VTerminal → Runbooks. Select your local macOS terminal.
Set `dockerBinary` to `/usr/local/bin/docker` (or your Docker executable) and
`dockerConfigDir` to your absolute Docker configuration directory, such as
`/Users/yourname/.docker`. OrbStack must already be running and its `orbstack`
context must exist.

Every Docker command passes the binary, `--config` directory, and `--context
orbstack` explicitly. This works with versions of VTerminal that reset `PATH`
and `HOME` for runbook commands. It never changes your global Docker context.
The prerequisite rejects contexts whose endpoint is not a local Unix socket.
Commands run without sudo. The declared `/var/lib/docker` write scope describes
the Docker daemon's storage inside the OrbStack VM, not a macOS host directory.

The first four steps only inspect the host, inputs, context, and Docker disk
usage. Stop after `docker-space-before` for a read-only diagnostic run. Review and
approve each later shell action individually; keep automatic approval off.

Cleanup is limited to:

- Stopped containers **created more than 24 hours ago**, using Docker's
  `container prune --filter until=24h` semantics. This is creation age, not time
  since the container stopped. The check and verification inspect the same
  creation criterion using Docker daemon time and macOS BSD `date -ju`.
  RFC3339 timestamps with fractional seconds and either `Z` or a numeric
  timezone offset are normalized before comparison.
- Dangling images without a container reference, using `image prune` without
  `--all`. Tagged images remain.
- Optional dangling build cache with `builder prune --filter until=168h`,
  without `--all`. Its check and verification require an operator attestation
  because Docker does not expose an equivalent stable read-only predicate.

Container cleanup deletes the selected stopped containers and their writable
layers. Keep any stopped container you still need by declining the apply step.
Volumes, running containers, tagged images, and unrelated host files are not
pruned. Concurrent builds or container changes can change the eligible set
between a check and its approval; use a quiet period for a consistent result.
Failures from listing, inspection, or timestamp parsing are execution errors,
not evidence that the host is already clean. Docker errors are kept visible.

The final step records Docker disk usage again. Reclaimed Docker storage does
not necessarily produce an equal immediate change in macOS free space because
OrbStack stores the daemon's filesystem in a virtual disk.

Docker's documented behavior:

- [Container prune creation-age filter](https://docs.docker.com/reference/cli/docker/container/prune/)
- [Dangling image cleanup](https://docs.docker.com/reference/cli/docker/image/prune/)
- [Dangling build-cache cleanup and filters](https://docs.docker.com/reference/cli/docker/builder/prune/)
