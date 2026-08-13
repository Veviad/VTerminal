# Idempotent software installation

This package illustrates `check → apply → verify`. The check makes a second
run assessment-only when the requested executable is already present. Input values
reach commands only through the declared `VRUN_PACKAGE` environment mapping.

The example supports `apt-get` and `dnf`; an unsupported package manager returns
exit code 64 and pauses for operator review.
