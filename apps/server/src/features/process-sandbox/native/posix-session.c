/* KenFutWork 同 Task helper 的 macOS PTY session 范围探针；不拥有第二套运行时。 */
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <unistd.h>

typedef struct { pid_t pid; struct proc_bsdinfo info; } Member;
typedef struct { pid_t session; uint64_t sec; uint64_t usec; } Identity;

static void fail(const char *message) {
  fprintf(stderr, "PTY session 范围检查失败：%s（errno=%d）\n", message, errno);
  exit(2);
}

static int process_info(pid_t pid, struct proc_bsdinfo *info) {
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (size == sizeof(*info)) return 1;
  errno = 0;
  if (getsid(pid) == -1 && errno == ESRCH) return 0;
  fail("无法读取进程身份");
  return 0;
}

static int verify_leader(Identity *identity, int initial) {
  struct proc_bsdinfo info;
  if (!process_info(identity->session, &info)) {
    if (initial) fail("PTY leader 已退出，不能签发新范围身份");
    return 0;
  }
  if (getsid(identity->session) != identity->session) fail("PTY leader 不是 session leader");
  if (initial) { identity->sec = info.pbi_start_tvsec; identity->usec = info.pbi_start_tvusec; }
  if (info.pbi_start_tvsec != identity->sec || info.pbi_start_tvusec != identity->usec)
    fail("PTY leader PID 已复用，禁止影响新会话");
  return 1;
}

static pid_t *process_ids(int *length) {
  for (;;) {
    int count = proc_listallpids(NULL, 0);
    if (count < 1 || count >= INT_MAX / (int)sizeof(pid_t) - 1) fail("进程清单不可用");
    int capacity = count + 1;
    pid_t *ids = calloc((size_t)capacity, sizeof(pid_t));
    if (!ids) fail("无法分配进程清单");
    int actual = proc_listallpids(ids, capacity * (int)sizeof(pid_t));
    if (actual < 0) { free(ids); fail("进程清单读取失败"); }
    if (actual < capacity) { *length = actual; return ids; }
    free(ids);
  }
}

static Member *session_members(Identity *identity, int *length) {
  verify_leader(identity, 0);
  int count;
  pid_t *ids = process_ids(&count);
  Member *members = calloc((size_t)count + 1, sizeof(Member));
  if (!members) fail("无法分配 session 清单");
  *length = 0;
  for (int i = 0; i < count; i++) {
    if (ids[i] < 1) continue;
    errno = 0;
    pid_t sid = getsid(ids[i]);
    if (sid == -1) { if (errno == ESRCH) continue; fail("无法读取 session 身份"); }
    if (sid != identity->session) continue;
    struct proc_bsdinfo info;
    if (!process_info(ids[i], &info)) continue;
    members[*length].pid = ids[i];
    members[(*length)++].info = info;
  }
  free(ids);
  verify_leader(identity, 0);
  return members;
}

static void signal_members(Identity *identity, Member *members, int count, int signal) {
  for (int i = 0; i < count; i++) {
    pid_t group = (pid_t)members[i].info.pbi_pgid;
    int duplicate = 0;
    for (int j = 0; j < i; j++) if (members[j].info.pbi_pgid == (uint32_t)group) duplicate = 1;
    if (duplicate) continue;
    struct proc_bsdinfo current;
    if (!process_info(members[i].pid, &current)) continue;
    if (current.pbi_start_tvsec != members[i].info.pbi_start_tvsec ||
        current.pbi_start_tvusec != members[i].info.pbi_start_tvusec ||
        getsid(members[i].pid) != identity->session || getpgid(members[i].pid) != group) continue;
    verify_leader(identity, 0);
    if (group < 2 || group == getpgrp()) fail("禁止影响 inspector 自身进程组");
    if (kill(-group, signal) != 0 && errno != ESRCH) fail("无法停止 session 进程组");
  }
}

static void print_members(Identity *identity, Member *members, int count) {
  printf("{\"sessionId\":%d,\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 ",\"members\":[", identity->session, identity->sec, identity->usec);
  for (int i = 0; i < count; i++) {
    struct proc_bsdinfo *info = &members[i].info;
    const char *state = info->pbi_status == SSTOP ? "stopped" : info->pbi_status == SZOMB ? "zombie" : "active";
    printf("%s{\"pid\":%d,\"groupId\":%u,\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 ",\"state\":\"%s\"}", i ? "," : "", members[i].pid, info->pbi_pgid, info->pbi_start_tvsec, info->pbi_start_tvusec, state);
  }
  printf("]}\n");
}

int main(int argc, char **argv) {
  if (argc != 5 && argc != 6) fail("无效调用参数");
  long pid = strtol(argv[2], NULL, 10);
  if (pid < 2 || pid > INT_MAX) fail("无效 leader PID");
  Identity identity = { (pid_t)pid, strtoull(argv[3], NULL, 10), strtoull(argv[4], NULL, 10) };
  int initial = strcmp(argv[1], "open") == 0;
  if (!initial && strcmp(argv[1], "scan") != 0 && strcmp(argv[1], "signal") != 0) fail("无效操作");
  verify_leader(&identity, initial);
  int count;
  Member *members = session_members(&identity, &count);
  if (strcmp(argv[1], "signal") == 0) {
    if (argc != 6) fail("缺少信号");
    int signal = atoi(argv[5]);
    if (signal != SIGSTOP && signal != SIGCONT && signal != SIGTERM && signal != SIGKILL) fail("不支持的信号");
    signal_members(&identity, members, count, signal);
  }
  print_members(&identity, members, count);
  free(members);
  return 0;
}
