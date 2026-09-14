#!/usr/bin/env bash
# =============================================================================
# references/ 子模块维护脚本
# 用于: 将 references/ 下所有子模块统一为「浅克隆(shallow clone, depth 1)」,
#       并支持常规更新到远端最新。
#
# 为什么需要浅克隆:
#   1. 大幅减少磁盘占用(.git/modules 体积)
#   2. 只有当前 commit 的历史, clone/update 更快
#   3. 避免 CodeGraph / IDE 索引超大历史
#
# 用法:
#   ./references/submodule-maintain.sh check      # 仅检查浅克隆状态(默认)
#   ./references/submodule-maintain.sh convert    # 将深度克隆子模块转为浅克隆
#   ./references/submodule-maintain.sh update     # 浅拉取所有子模块到远端最新
#   ./references/submodule-maintain.sh all        # convert + update
#
# 脚本位置: references/submodule-maintain.sh (从仓库根目录执行)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 浅克隆会记录的参考 commit(用于后续 fetch 定点 checkout)
DEPTH=1

usage() {   sed -n '2,22p' "$0";   exit 0; }

# 列出所有子模块路径, 每行一个
submodule_paths() {
  git config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path$' \
    | sed -E 's/^submodule\.(.*)\.path$/\1/' \
    || true
}

# 判断某目录是否为浅仓库
is_shallow() {
  local dir="$1"
  [[ "$(git -C "$dir" rev-parse --is-shallow-repository 2>/dev/null)" == "true" ]]
}

# 判断某目录是否是 git 仓库的工作区(gitdir 存在)
is_git_worktree() {
  local dir="$1"
  [[ -d "$dir/.git" ]] || [[ -f "$dir/.git" ]]
}

# ---------------------------------------------------------------------------
# check: 检查每个子模块的浅克隆状态
# ---------------------------------------------------------------------------
check() {
  echo "=== 子模块浅克隆状态检查 ==="
  local total=0 shallow=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    total=$((total + 1))
    if ! is_git_worktree "$path"; then
      echo "  [缺失] $path (未 checkout, 跳过)"
      continue
    fi
    if is_shallow "$path"; then
      shallow=$((shallow + 1))
      echo "  [浅克隆] $path"
    else
      echo "  [深度克隆] $path"
    fi
  done < <(submodule_paths)
  echo "---"
  echo "总计 $total, 浅克隆 $shallow, 深度克隆 $((total - shallow))"
}

# ---------------------------------------------------------------------------
# convert: 将深度克隆子模块转为浅克隆(depth 1)
# ---------------------------------------------------------------------------
convert() {
  echo "=== 将深度克隆子模块转为浅克隆(depth=$DEPTH) ==="
  local any=false
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    is_git_worktree "$path" || { echo "[缺失] $path (跳过)"; continue; }
    is_shallow "$path" && { echo "[已是浅克隆] $path (跳过)"; continue; }

    any=true
    local url branch target
    url="$(git config --file .gitmodules --get "submodule.$path.url")"
    # gitsubmodule update 的默认追踪分支; 取 refs/heads/ 主干
    branch="$(git ls-remote --symref "$url" HEAD 2>/dev/null | sed -E 's@ref: refs/heads/@@; s@[[:space:]].*@@')"
    # 主仓库 gitlink 当前记录的 commit
    target="$(git ls-files --stage "$path" 2>/dev/null | awk '{print $2}')"

    echo "--- 转换 $path (branch=$branch) ---"
    # 1. 移除旧工作区与 modules 副本
    rm -rf "$path" ".git/modules/$path"
    # 2. 浅克隆到目标分支; 用 --separate-git-dir 保持 gitdir 指向 .git/modules/
    if [[ -n "$branch" ]]; then
      git clone --depth "$DEPTH" --separate-git-dir=".git/modules/$path" -b "$branch" "$url" "$path"
    else
      # 分支探测失败时的兜底: 直接克隆默认 HEAD
      git clone --depth "$DEPTH" --separate-git-dir=".git/modules/$path" "$url" "$path"
    fi
    # 3. 若 gitlink 指向的 commit 不在浅历史中, fetch 它并 checkout, 保证与主仓库一致
    if [[ -n "$target" ]]; then
      if ! git -C "$path" cat-file -e "$target" 2>/dev/null; then
        git -C "$path" fetch origin --depth 1 "$target"
      fi
      git -C "$path" checkout -q "$target" || true
    fi
    echo "    完成, HEAD=$(git -C "$path" rev-parse --short HEAD)"
  done < <(submodule_paths)
  [[ "$any" == false ]] && echo "没有需要转换的子模块, 均为浅克隆。"
}

# ---------------------------------------------------------------------------
# update: 浅拉取所有子模块到远端最新(提交指针, 不改变主仓库 gitlink)
# ---------------------------------------------------------------------------
update() {
  echo "=== 浅更新所有子模块到远端最新 ==="
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    is_git_worktree "$path" || { echo "[缺失] $path (跳过)"; continue; }
    echo "--- $path ---"
    git -C "$path" fetch origin --depth "$DEPTH" 2>/dev/null || true
    git -C "$path" reset --hard origin/HEAD 2>/dev/null || {
      # origin/HEAD 不存在时回退到默认分支
      local branch
      branch="$(git -C "$path" rev-parse --abbrev-ref origin/HEAD 2>/dev/null || true)"
      [[ -z "$branch" ]] && branch="main"
      git -C "$path" reset --hard "origin/$branch" 2>/dev/null || true
    }
    echo "    新 HEAD=$(git -C "$path" rev-parse --short HEAD)"
  done < <(submodule_paths)
  echo "=== 更新完成 ==="
  echo "提示: 子模块工作区已更新, 但主仓库的 gitlink 需重新记录:"
  echo "      git add references/* && git commit"
}

# ---------------------------------------------------------------------------
action="${1:-check}"
case "$action" in
  check)   check ;;
  convert) convert ;;
  update)  update ;;
  all)     convert; update ;;
  *)       usage ;;
esac
