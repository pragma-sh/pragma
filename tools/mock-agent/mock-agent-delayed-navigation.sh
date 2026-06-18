#!/usr/bin/env bash
set -euo pipefail

printf 'Reporting mock agent started now. Navigate away within 10 seconds.\n'
pragma-agent --agent mock report started || true
sleep 10
printf 'Reporting mock agent attention now.\n'
pragma-agent --agent mock report attention --kind question || true
printf 'Done. Use the alert action to navigate back, then viewing this tab should clear the dot.\n'
