#!/bin/bash
# goal-loop wrapper（本机 skill 实际安装路径回退，说明同 loop.sh）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SCRIPTS="/c/Users/future/.workbuddy/skills/goal-loop__skillhub/scripts"
if [ -x "$SCRIPT_DIR/.claude/skills/goal-loop/scripts/clean-state.sh" ]; then
    exec "$SCRIPT_DIR/.claude/skills/goal-loop/scripts/clean-state.sh" "$@"
elif [ -x "$HOME/.claude/skills/goal-loop/scripts/clean-state.sh" ]; then
    exec "$HOME/.claude/skills/goal-loop/scripts/clean-state.sh" "$@"
else
    exec "$SKILL_SCRIPTS/clean-state.sh" "$@"
fi
