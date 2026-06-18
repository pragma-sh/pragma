#!/usr/bin/env bash
set -euo pipefail

# A freshly opened agent is idle, not working — don't report "started" until the
# user actually drives it into a state below. Reporting on launch is what made an
# untouched agent show a yellow "in progress" dot.

# Clear the indicator whenever this process goes away, including Ctrl-C. bash
# runs an EXIT trap even when the script is terminated by SIGINT, and a plain
# `cmd; report` chain would not (a SIGINT-killed command aborts the list), so the
# trap is what keeps a killed agent from leaving a stale "in progress" dot.
trap 'pragma-agent --agent mock report stopped || true' EXIT

while true; do
  printf '\nMock agent\n'
  printf '1) in progress\n'
  printf '2) attention: question\n'
  printf '3) attention: command\n'
  printf '4) stopped\n'
  printf '5) delayed attention in 10s\n'
  printf '6) exit without report\n'
  printf '> '
  read -r choice
  case "$choice" in
    1) pragma-agent --agent mock report started || true ;;
    2) pragma-agent --agent mock report attention --kind question || true ;;
    3) pragma-agent --agent mock report attention --kind command || true ;;
    4) exit 0 ;;
    5) "$(dirname "$0")/mock-agent-delayed-navigation.sh" ;;
    6)
      # Deliberately leave the status as-is to exercise the misbehaving-agent path.
      trap - EXIT
      exit 0
      ;;
    *) printf 'unknown choice\n' ;;
  esac
done
