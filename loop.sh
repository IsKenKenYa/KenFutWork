#!/bin/bash
# goal-loop wrapper（本机 skill 实际安装在 ~/.workbuddy/skills/goal-loop__skillhub，
# SKILL.md 模板里的 .claude/skills 路径在本机不存在，故补第三条回退）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SCRIPTS="/c/Users/future/.workbuddy/skills/goal-loop__skillhub/scripts"
if [ -x "$SCRIPT_DIR/.claude/skills/goal-loop/scripts/loop.sh" ]; then
    exec "$SCRIPT_DIR/.claude/skills/goal-loop/scripts/loop.sh" "$@"
elif [ -x "$HOME/.claude/skills/goal-loop/scripts/loop.sh" ]; then
    exec "$HOME/.claude/skills/goal-loop/scripts/loop.sh" "$@"
else
    exec "$SKILL_SCRIPTS/loop.sh" "$@"
fi
