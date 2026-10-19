#!/usr/bin/env bash
set -eu

printf '\nSolid Waddle updater\n\n'

if [ -n "$(git status --porcelain)" ]; then
  printf 'STOP: This workspace has local changes. Nothing was updated.\n'
  printf 'Please show the Git changes before continuing so your work is not overwritten.\n'
  exit 1
fi

printf 'Updating from origin/main...\n'
git pull --ff-only origin main

printf '\nRunning tests...\n'
npm test

printf '\nUpdate and test command finished. Check the test results above.\n'
