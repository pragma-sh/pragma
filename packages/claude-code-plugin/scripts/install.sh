#!/bin/sh
set -eu
claude plugin marketplace add "$PWD"
claude plugin install pragma-claude-code@pragma --scope user
